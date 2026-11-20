// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { SignRequest } from "@/contracts/xrpl";

import { loadXrplConfig } from "../../config";
import { XrplServiceError } from "../../errors";
import { signRequestStatus, SIGN_IN_EXPIRY_MINUTES, WalletSignRequests } from "../sign-requests";
import type { XamanClient, XamanPayloadResult } from "../xaman";

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ACCOUNT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const config = loadXrplConfig({});

function payload(
  meta: Partial<XamanPayloadResult["meta"]> = {},
  response: Partial<XamanPayloadResult["response"]> = {},
  txType = "SignIn",
): XamanPayloadResult {
  return {
    meta: {
      exists: true,
      uuid: UUID,
      resolved: false,
      signed: false,
      cancelled: false,
      expired: false,
      app_opened: false,
      force_network: "TESTNET",
      ...meta,
    },
    payload: { tx_type: txType, expires_at: "2026-11-20T18:33:57Z" },
    response: {
      account: "",
      hex: null,
      txid: null,
      environment_nodetype: null,
      dispatched_result: null,
      resolved_at: null,
      ...response,
    },
  };
}

const SIGNED_ON = (network: string | null) =>
  payload(
    { resolved: true, signed: true },
    { account: ACCOUNT, hex: "120000ABCD", environment_nodetype: network },
  );

function setup(result: XamanPayloadResult) {
  const xaman = {
    createPayload: vi.fn(async () => ({
      uuid: UUID,
      next: { always: `https://xumm.app/sign/${UUID}` },
      refs: { qr_png: "", websocket_status: "" },
      pushed: false,
    })),
    getPayload: vi.fn(async () => result),
    cancelPayload: vi.fn(async () => ({ cancelled: true, reason: "OK" })),
  };
  return { xaman, service: new WalletSignRequests(config, xaman as unknown as XamanClient) };
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

describe("signRequestStatus", () => {
  it.each([
    [{}, "PENDING"],
    [{ app_opened: true }, "OPENED"],
    [{ resolved: true, signed: true, app_opened: true }, "SIGNED"],
    [{ resolved: true, app_opened: true }, "REJECTED"],
    [{ expired: true }, "EXPIRED"],
    [{ cancelled: true }, "CANCELLED"],
  ] as const)("maps %o to %s", (meta, status) => {
    expect(signRequestStatus(payload(meta).meta)).toBe(status);
  });
});

describe("WalletSignRequests", () => {
  it("creates a sign-in pinned to the app's network with a short expiry", async () => {
    const { xaman, service } = setup(payload());
    const request = await service.createSignIn();

    const [input] = xaman.createPayload.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>];
    expect(input.txjson).toEqual({ TransactionType: "SignIn" });
    expect(input.options).toEqual({ expire: SIGN_IN_EXPIRY_MINUTES, force_network: "TESTNET" });
    expect(SignRequest.parse(request)).toEqual({
      id: UUID,
      kind: "SIGN_IN",
      status: "PENDING",
      signUrl: `https://xumm.app/sign/${UUID}`,
      qrPngUrl: `https://xumm.app/sign/${UUID}_q.png`,
      expiresAt: "2026-11-20T18:33:57.000Z",
      account: null,
      walletNetwork: null,
      networkMatches: null,
    });
  });

  it("returns the signing account once signed on the right network", async () => {
    const request = await setup(SIGNED_ON("TESTNET")).service.get(UUID);
    expect(request).toMatchObject({
      status: "SIGNED",
      account: ACCOUNT,
      walletNetwork: "TESTNET",
      networkMatches: true,
    });
  });

  it("flags a wallet that signed on another network", async () => {
    const request = await setup(SIGNED_ON("MAINNET")).service.get(UUID);
    expect(request).toMatchObject({ status: "SIGNED", walletNetwork: "MAINNET", networkMatches: false });
  });

  it("falls back to the enforced network when Xaman does not report one", async () => {
    expect(await setup(SIGNED_ON(null)).service.get(UUID)).toMatchObject({ networkMatches: true });
  });

  it("rejects malformed IDs and requests that are not sign-ins", async () => {
    expect((await caught(setup(payload()).service.get("not-a-uuid"))).code).toBe("INVALID_INPUT");
    const payment = setup(payload({}, {}, "Payment"));
    expect((await caught(payment.service.get(UUID))).code).toBe("NOT_FOUND");
    expect((await caught(payment.service.cancel(UUID))).code).toBe("NOT_FOUND");
    expect(payment.xaman.cancelPayload).not.toHaveBeenCalled();
  });

  it("refuses a signed request without a valid account", async () => {
    const broken = setup(payload({ resolved: true, signed: true }, { account: "not-an-address" }));
    expect((await caught(broken.service.get(UUID))).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("cancels and returns the refreshed state", async () => {
    const { xaman, service } = setup(payload({ cancelled: true }));
    expect((await service.cancel(UUID)).status).toBe("CANCELLED");
    expect(xaman.cancelPayload).toHaveBeenCalledWith(UUID);
  });

  it("exposes the signed blob for session linking only when signed on the right network", async () => {
    expect(await setup(SIGNED_ON("TESTNET")).service.getSignedSignIn(UUID)).toMatchObject({
      request: { account: ACCOUNT },
      signedHex: "120000ABCD",
    });
    expect(await setup(SIGNED_ON("MAINNET")).service.getSignedSignIn(UUID)).toBeNull();
    expect(await setup(payload()).service.getSignedSignIn(UUID)).toBeNull();
  });
});
