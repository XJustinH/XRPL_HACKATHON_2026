// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "../../errors";
import { loadXamanCredentials, XamanClient } from "../xaman";

const CREDENTIALS = { apiKey: "key-123", apiSecret: "secret-456" };
const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const BASE = "https://xaman.test/api";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CREATED = {
  uuid: UUID,
  next: { always: `https://xumm.app/sign/${UUID}` },
  refs: {
    qr_png: `https://xumm.app/sign/${UUID}_q.png`,
    qr_matrix: `https://xumm.app/sign/${UUID}_q.json`,
    websocket_status: `wss://xumm.app/sign/${UUID}`,
  },
  pushed: false,
};

const PAYLOAD = {
  meta: {
    exists: true,
    uuid: UUID,
    resolved: false,
    signed: false,
    cancelled: false,
    expired: false,
    app_opened: false,
    force_network: "TESTNET",
  },
  payload: { tx_type: "SignIn", expires_at: "2026-11-20T18:33:57Z" },
  response: {
    account: "",
    hex: null,
    txid: null,
    environment_nodetype: null,
    dispatched_result: null,
    resolved_at: null,
  },
};

function client(respond: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => respond());
  return { fetchImpl, xaman: new XamanClient(CREDENTIALS, fetchImpl as unknown as typeof fetch, BASE) };
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

describe("loadXamanCredentials", () => {
  it("reads the key and secret", () => {
    expect(loadXamanCredentials({ XAMAN_API_KEY: " k ", XAMAN_API_SECRET: "s" })).toEqual({
      apiKey: "k",
      apiSecret: "s",
    });
  });

  it.each([{}, { XAMAN_API_KEY: "k" }, { XAMAN_API_KEY: "k", XAMAN_API_SECRET: "  " }])(
    "refuses missing credentials %o",
    (env) => {
      expect(() => loadXamanCredentials(env)).toThrow(/XAMAN_API_KEY and XAMAN_API_SECRET/);
    },
  );
});

describe("XamanClient", () => {
  it("creates a payload with the API key headers and a JSON body", async () => {
    const { fetchImpl, xaman } = client(() => json(200, CREATED));
    const created = await xaman.createPayload({ txjson: { TransactionType: "SignIn" } });
    expect(created).toMatchObject({ uuid: UUID, next: { always: CREATED.next.always } });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/payload`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-API-Key": "key-123", "X-API-Secret": "secret-456" });
    expect(JSON.parse(String(init.body))).toEqual({ txjson: { TransactionType: "SignIn" } });
  });

  it("reads and cancels payloads by UUID", async () => {
    const { fetchImpl, xaman } = client(() => json(200, PAYLOAD));
    expect((await xaman.getPayload(UUID)).meta.force_network).toBe("TESTNET");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/payload/${UUID}`);

    const cancel = client(() => json(200, { result: { cancelled: true, reason: "OK" }, meta: PAYLOAD.meta }));
    expect(await cancel.xaman.cancelPayload(UUID)).toEqual({ cancelled: true, reason: "OK" });
    expect(cancel.fetchImpl.mock.calls[0]![1].method).toBe("DELETE");
  });

  it.each([
    [401, "CONFIG_ERROR"],
    [403, "CONFIG_ERROR"],
    [404, "NOT_FOUND"],
    [400, "INVALID_INPUT"],
    [429, "PROVIDER_UNAVAILABLE"],
    [502, "PROVIDER_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const { xaman } = client(() => json(status, { error: { reference: "x", code: status } }));
    expect((await caught(xaman.getPayload(UUID))).code).toBe(code);
  });

  it("treats network failures and malformed responses as a provider outage", async () => {
    const offline = client(() => {
      throw new TypeError("fetch failed");
    });
    const outage = await caught(offline.xaman.getPayload(UUID));
    expect(outage.code).toBe("PROVIDER_UNAVAILABLE");
    expect(outage.retryable).toBe(true);

    const garbled = client(() => json(200, { unexpected: true }));
    expect((await caught(garbled.xaman.getPayload(UUID))).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("never repeats the API secret in error messages", async () => {
    const { xaman } = client(() => json(403, { error: { code: 813 } }));
    expect((await caught(xaman.getPayload(UUID))).message).not.toContain(CREDENTIALS.apiSecret);
  });
});
