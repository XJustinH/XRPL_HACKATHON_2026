// @vitest-environment node
import { ConnectionError, RippledError, TimeoutError } from "xrpl";
import { describe, expect, it } from "vitest";

import { XrplConnectionManager } from "../client";
import { loadXrplConfig } from "../config";
import { XrplServiceError } from "../errors";
import { fakeNetwork, type FakeNode } from "./fake-client";

const PRIMARY = "wss://primary.test/";
const FALLBACK = "wss://fallback.test/";
const config = loadXrplConfig({});

function manager(nodes: Record<string, FakeNode>, endpoints = [PRIMARY, FALLBACK]) {
  const network = fakeNetwork(nodes);
  return { ...network, xrpl: new XrplConnectionManager(config, endpoints, network.factory) };
}

async function caught(promise: Promise<unknown>): Promise<XrplServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(XrplServiceError);
    return error as XrplServiceError;
  }
  throw new Error("expected promise to reject");
}

const accountInfo = { command: "account_info", account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" } as const;

describe("XrplConnectionManager", () => {
  it("verifies the network and reports node status", async () => {
    const { xrpl } = manager({ [PRIMARY]: {}, [FALLBACK]: {} });
    const status = await xrpl.getNetworkStatus();
    expect(status).toMatchObject({
      network: "TESTNET",
      networkId: 1,
      endpoint: PRIMARY,
      serverState: "full",
      buildVersion: "3.4.1",
      validatedLedger: { index: 100, hash: "LEDGERHASH", ageSeconds: 2 },
    });
  });

  it("fails over to the next endpoint when the primary cannot connect", async () => {
    const { xrpl, created } = manager({
      [PRIMARY]: { connectError: new ConnectionError("refused") },
      [FALLBACK]: { handler: () => ({ result: { ok: true } }) },
    });
    const { response, endpoint } = await xrpl.request(accountInfo);
    expect(endpoint).toBe(FALLBACK);
    expect(response).toEqual({ result: { ok: true } });
    expect(created[0]?.disconnectCalls).toBe(1);
  });

  it("reports NODE_UNAVAILABLE when every endpoint is down", async () => {
    const { xrpl } = manager({
      [PRIMARY]: { connectError: new ConnectionError("refused") },
      [FALLBACK]: { connectError: new TimeoutError("timed out") },
    });
    const error = await caught(xrpl.request(accountInfo));
    expect(error.code).toBe("NODE_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain(PRIMARY);
    expect(error.message).toContain(FALLBACK);
  });

  it("refuses a Mainnet node outright and does not fail over", async () => {
    const { xrpl, created } = manager({ [PRIMARY]: { networkId: 0 }, [FALLBACK]: {} });
    const error = await caught(xrpl.request(accountInfo));
    expect(error.code).toBe("WRONG_NETWORK");
    expect(error.message).toContain("Mainnet");
    expect(created).toHaveLength(1);
    expect(created[0]?.connected).toBe(false);
  });

  it("refuses a node that does not report its network id", async () => {
    const { xrpl } = manager({ [PRIMARY]: { networkId: undefined } }, [PRIMARY]);
    expect((await caught(xrpl.connect())).code).toBe("WRONG_NETWORK");
  });

  it("retries a timed-out read once on the next endpoint", async () => {
    const { xrpl } = manager({
      [PRIMARY]: {
        handler: () => {
          throw new TimeoutError("slow");
        },
      },
      [FALLBACK]: { handler: () => ({ result: { from: "fallback" } }) },
    });
    const { response, endpoint } = await xrpl.request(accountInfo);
    expect(endpoint).toBe(FALLBACK);
    expect(response).toEqual({ result: { from: "fallback" } });
  });

  it("does not retry errors that are not transient", async () => {
    const { xrpl, created } = manager({
      [PRIMARY]: {
        handler: () => {
          throw new RippledError("Account not found.", { error: "actNotFound" });
        },
      },
      [FALLBACK]: {},
    });
    const error = await caught(xrpl.request(accountInfo));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.rippledError).toBe("actNotFound");
    expect(error.endpoint).toBe(PRIMARY);
    expect(created).toHaveLength(1);
  });

  it("surfaces TIMEOUT when there is no other endpoint to try", async () => {
    const { xrpl } = manager(
      {
        [PRIMARY]: {
          handler: () => {
            throw new TimeoutError("slow");
          },
        },
      },
      [PRIMARY],
    );
    expect((await caught(xrpl.request(accountInfo))).code).toBe("TIMEOUT");
  });

  it("shares one connection attempt between concurrent callers", async () => {
    const { xrpl, created } = manager({ [PRIMARY]: { handler: () => ({ result: {} }) } }, [PRIMARY]);
    await Promise.all([xrpl.request(accountInfo), xrpl.request(accountInfo), xrpl.request(accountInfo)]);
    expect(created).toHaveLength(1);
  });

  it("reconnects after the connection drops", async () => {
    const { xrpl, created } = manager({ [PRIMARY]: { handler: () => ({ result: {} }) } }, [PRIMARY]);
    await xrpl.request(accountInfo);
    created[0]!.connected = false;
    await xrpl.request(accountInfo);
    expect(created).toHaveLength(2);
  });

  it("disconnects cleanly", async () => {
    const { xrpl, created } = manager({ [PRIMARY]: {} }, [PRIMARY]);
    await xrpl.connect();
    await xrpl.disconnect();
    expect(created[0]?.connected).toBe(false);
    expect(xrpl.currentEndpoint).toBeNull();
  });

  it("requires at least one endpoint", () => {
    expect(() => new XrplConnectionManager(config, [], fakeNetwork({}).factory)).toThrow(/No XRPL endpoints/);
  });
});
