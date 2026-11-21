// @vitest-environment node
import { encode } from "xrpl";
import { describe, expect, it, vi } from "vitest";

import { TransactionRequest, type LedgerTxLookup } from "@/contracts/xrpl";

import { loadXrplConfig } from "../../config";
import { XrplServiceError } from "../../errors";
import { TRANSACTION_REQUEST_EXPIRY_MINUTES, WalletTransactionRequests } from "../transaction-requests";
import type { XamanClient, XamanPayloadResult } from "../xaman";

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ACCOUNT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const EXPLORER = `https://testnet.xrpl.org/transactions/${TX_HASH}`;
const config = loadXrplConfig({});

/** A real signed-blob encoding whose LastLedgerSequence is 1000. */
const SIGNED_HEX_LLS_1000 = encode({
  TransactionType: "AccountSet",
  Account: ACCOUNT,
  Fee: "12",
  Sequence: 5,
  LastLedgerSequence: 1000,
  SigningPubKey: "",
});

function payload({
  meta = {},
  response = {},
  txType = "AccountSet",
  blob = { purpose: "TEST", reference: "ticket-1" } as unknown,
}: {
  meta?: Partial<XamanPayloadResult["meta"]>;
  response?: Partial<XamanPayloadResult["response"]>;
  txType?: string;
  blob?: unknown;
} = {}): XamanPayloadResult {
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
    payload: {
      tx_type: txType,
      expires_at: "2026-11-20T19:10:00Z",
      request_json: { TransactionType: txType, Account: ACCOUNT },
    },
    response: {
      account: null,
      hex: null,
      txid: null,
      environment_nodetype: null,
      dispatched_result: null,
      resolved_at: null,
      ...response,
    },
    custom_meta: { instruction: "Developer check", blob },
  };
}

const signed = (response: Partial<XamanPayloadResult["response"]> = {}) =>
  payload({
    meta: { resolved: true, signed: true, app_opened: true },
    response: { account: ACCOUNT, txid: TX_HASH, environment_nodetype: "TESTNET", ...response },
  });

function lookup(overrides: Partial<LedgerTxLookup>): LedgerTxLookup {
  return {
    hash: TX_HASH,
    status: "VALIDATED",
    engineResult: "tesSUCCESS",
    succeeded: true,
    transactionType: "AccountSet",
    account: ACCOUNT,
    ledgerIndex: 1234,
    closeTime: "2026-11-20T19:01:00Z",
    nftokenId: null,
    offerIndex: null,
    acceptedSellOfferIndex: null,
    explorerUrl: EXPLORER,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 1234,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
    ...overrides,
  };
}

const NOT_FOUND_LOOKUP = lookup({
  status: "NOT_FOUND",
  engineResult: null,
  succeeded: false,
  ledgerIndex: null,
  explorerUrl: null,
});

function setup(
  result: XamanPayloadResult,
  {
    tx = NOT_FOUND_LOOKUP,
    txError,
    validatedIndex = 500,
  }: { tx?: LedgerTxLookup; txError?: Error; validatedIndex?: number } = {},
) {
  const xaman = {
    createPayload: vi.fn(async () => ({
      uuid: UUID,
      next: { always: "" },
      refs: { qr_png: "", websocket_status: "" },
      pushed: false,
    })),
    getPayload: vi.fn(async () => result),
    cancelPayload: vi.fn(async () => ({ cancelled: true, reason: "OK" })),
  };
  const ledger = {
    getTransaction: vi.fn(async () => {
      if (txError) throw txError;
      return tx;
    }),
    getNetworkStatus: vi.fn(async () => ({
      validatedLedger: { index: validatedIndex, hash: "H", ageSeconds: 1 },
    })),
  };
  const service = new WalletTransactionRequests(config, xaman as unknown as XamanClient, ledger as never);
  return { xaman, ledger, service };
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

const TEST_TX = { TransactionType: "AccountSet", Account: ACCOUNT };

describe("WalletTransactionRequests.create", () => {
  it("asks Xaman to sign and submit on the app's network, tagging the purpose", async () => {
    const { xaman, service } = setup(payload());
    const request = await service.create({
      purpose: "TEST",
      txjson: TEST_TX,
      instruction: "Developer check",
      reference: "ticket-1",
    });

    const [input] = xaman.createPayload.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toEqual({
      txjson: TEST_TX,
      options: {
        submit: true,
        expire: TRANSACTION_REQUEST_EXPIRY_MINUTES,
        force_network: "TESTNET",
        signers: [ACCOUNT],
      },
      custom_meta: { instruction: "Developer check", blob: { purpose: "TEST", reference: "ticket-1" } },
    });
    expect(TransactionRequest.parse(request)).toMatchObject({
      id: UUID,
      purpose: "TEST",
      reference: "ticket-1",
      status: "PENDING",
      transactionType: "AccountSet",
      account: ACCOUNT,
      signUrl: `https://xumm.app/sign/${UUID}`,
      qrPngUrl: `https://xumm.app/sign/${UUID}_q.png`,
      txHash: null,
      failureReason: null,
    });
  });

  it("only allows the transaction type that belongs to the purpose", async () => {
    const { xaman, service } = setup(payload());
    const payment = { TransactionType: "Payment", Account: ACCOUNT, Destination: ACCOUNT, Amount: "1" };
    expect((await caught(service.create({ purpose: "TEST", txjson: payment, instruction: "x" }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(xaman.createPayload).not.toHaveBeenCalled();
  });

  it.each([
    [{ txjson: { TransactionType: "AccountSet", Account: "not-an-address" }, instruction: "x" }],
    [{ txjson: TEST_TX, instruction: "   " }],
    [{ txjson: TEST_TX, instruction: "x".repeat(281) }],
    [{ txjson: TEST_TX, instruction: "x", reference: "r".repeat(101) }],
  ])("rejects invalid input %#", async (input) => {
    const { service } = setup(payload());
    expect((await caught(service.create({ purpose: "TEST", ...input }))).code).toBe("INVALID_INPUT");
  });
});

describe("WalletTransactionRequests.get", () => {
  it.each([
    [{}, "PENDING"],
    [{ app_opened: true }, "OPENED"],
    [{ resolved: true, app_opened: true }, "REJECTED"],
    [{ expired: true }, "EXPIRED"],
    [{ cancelled: true }, "CANCELLED"],
  ] as const)("reports %o as %s without touching the ledger", async (meta, status) => {
    const { ledger, service } = setup(payload({ meta }));
    expect((await service.get(UUID)).status).toBe(status);
    expect(ledger.getTransaction).not.toHaveBeenCalled();
  });

  describe("a request opened before it expired (XRPL-027)", () => {
    /** Xaman's expiry only bounds opening: an opened request can still be signed afterwards. */
    function openedThenExpired(lastLedgerSequence?: number, appOpened = true) {
      const result = payload({ meta: { expired: true, app_opened: appOpened } });
      if (lastLedgerSequence !== undefined) {
        result.payload.request_json = {
          ...result.payload.request_json,
          LastLedgerSequence: lastLedgerSequence,
        };
      }
      return result;
    }

    it("stays OPENED until its LastLedgerSequence passes, since it can still be signed", async () => {
      const before = setup(openedThenExpired(1000), { validatedIndex: 1000 });
      // Xaman's expiry is past and no longer bounds it, so the card isn't given one to show.
      expect(await before.service.get(UUID)).toMatchObject({ status: "OPENED", expiresAt: null });
      const after = setup(openedThenExpired(1000), { validatedIndex: 1001 });
      expect(await after.service.get(UUID)).toMatchObject({
        status: "EXPIRED",
        expiresAt: "2026-11-20T19:10:00.000Z",
      });
    });

    it("is REJECTED once declined, even after Xaman's expiry: nothing is left to sign", async () => {
      const declinedLate = openedThenExpired(1000);
      declinedLate.meta.resolved = true;
      const { ledger, service } = setup(declinedLate, { validatedIndex: 999 });

      expect((await service.get(UUID)).status).toBe("REJECTED");
      expect(ledger.getNetworkStatus).not.toHaveBeenCalled();
      // The same for a request with no LastLedgerSequence (offers and purchases today).
      const offer = openedThenExpired();
      offer.meta.resolved = true;
      expect((await setup(offer).service.get(UUID)).status).toBe("REJECTED");
    });

    it("keeps waiting while the ledger height is unknown", async () => {
      const { ledger, service } = setup(openedThenExpired(1000));
      ledger.getNetworkStatus.mockRejectedValueOnce(new XrplServiceError("TIMEOUT", "slow"));
      expect((await service.get(UUID)).status).toBe("OPENED");
    });

    it("is EXPIRED without a LastLedgerSequence to bound it, or when it was never opened", async () => {
      expect((await setup(openedThenExpired()).service.get(UUID)).status).toBe("EXPIRED");
      const unopened = setup(openedThenExpired(1000, false), { validatedIndex: 999 });
      expect((await unopened.service.get(UUID)).status).toBe("EXPIRED");
    });
  });

  it("is CONFIRMED only once the ledger validated it with tesSUCCESS", async () => {
    const { service } = setup(signed(), { tx: lookup({}) });
    expect(TransactionRequest.parse(await service.get(UUID))).toMatchObject({
      status: "CONFIRMED",
      txHash: TX_HASH,
      engineResult: "tesSUCCESS",
      ledgerIndex: 1234,
      explorerUrl: EXPLORER,
      failureReason: null,
    });
  });

  it("reports a validated failure as LEDGER_REJECTED with its result and explorer link", async () => {
    const { service } = setup(signed(), {
      tx: lookup({ engineResult: "tecNO_PERMISSION", succeeded: false }),
    });
    expect(await service.get(UUID)).toMatchObject({
      status: "FAILED",
      failureReason: "LEDGER_REJECTED",
      engineResult: "tecNO_PERMISSION",
      explorerUrl: EXPLORER,
    });
  });

  it("reports a transaction the network refused as NETWORK_REJECTED", async () => {
    const { service } = setup(signed({ dispatched_result: "tefPAST_SEQ" }));
    expect(await service.get(UUID)).toMatchObject({
      status: "FAILED",
      failureReason: "NETWORK_REJECTED",
      engineResult: "tefPAST_SEQ",
      explorerUrl: null,
    });
  });

  it("doesn't take a refusal at its word while the node holds the transaction unvalidated (XRPL-027)", async () => {
    const pending = lookup({ status: "PENDING", succeeded: false, ledgerIndex: null, explorerUrl: null });
    const refused = signed({ hex: SIGNED_HEX_LLS_1000, dispatched_result: "tefPAST_SEQ" });

    const waiting = setup(refused, { tx: pending, validatedIndex: 999 });
    expect(await waiting.service.get(UUID)).toMatchObject({ status: "SUBMITTED", failureReason: null });

    // Its LastLedgerSequence still settles it.
    const expired = setup(refused, { tx: pending, validatedIndex: 1001 });
    expect(await expired.service.get(UUID)).toMatchObject({
      status: "FAILED",
      failureReason: "NOT_VALIDATED_IN_TIME",
    });
  });

  it("reports NOT_VALIDATED_IN_TIME once the ledger passes the transaction's LastLedgerSequence", async () => {
    const { service } = setup(signed({ hex: SIGNED_HEX_LLS_1000, dispatched_result: "tesSUCCESS" }), {
      validatedIndex: 1001,
    });
    expect(await service.get(UUID)).toMatchObject({
      status: "FAILED",
      failureReason: "NOT_VALIDATED_IN_TIME",
    });
  });

  it("keeps waiting (SUBMITTED) while there is still time to validate", async () => {
    const { service } = setup(signed({ hex: SIGNED_HEX_LLS_1000, dispatched_result: "terQUEUED" }), {
      validatedIndex: 999,
    });
    expect(await service.get(UUID)).toMatchObject({
      status: "SUBMITTED",
      txHash: TX_HASH,
      failureReason: null,
    });
  });

  it("keeps waiting when the ledger is briefly unreachable", async () => {
    const { service } = setup(signed(), { txError: new XrplServiceError("TIMEOUT", "slow") });
    expect((await service.get(UUID)).status).toBe("SUBMITTED");
  });

  it("refuses a transaction signed on another network", async () => {
    const { ledger, service } = setup(signed({ environment_nodetype: "MAINNET" }));
    expect(await service.get(UUID)).toMatchObject({ status: "FAILED", failureReason: "WRONG_NETWORK" });
    expect(ledger.getTransaction).not.toHaveBeenCalled();
  });

  it("refuses a transaction another account signed, even when the ledger validated it", async () => {
    const { service } = setup(
      signed({ account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }),
      { tx: lookup({ account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }) },
    );
    expect(await service.get(UUID)).toMatchObject({
      status: "FAILED",
      failureReason: "WRONG_WALLET",
      txHash: TX_HASH,
    });
  });

  it("treats a signed request without a transaction ID yet as SUBMITTED", async () => {
    const { service } = setup(signed({ txid: null }));
    expect(await service.get(UUID)).toMatchObject({ status: "SUBMITTED", txHash: null });
  });

  it.each([
    ["a sign-in", payload({ txType: "SignIn" })],
    ["a request without our metadata", payload({ blob: null })],
    ["an unknown purpose", payload({ blob: { purpose: "MINT_EVERYTHING" } })],
  ])("does not expose %s", async (_label, result) => {
    expect((await caught(setup(result).service.get(UUID))).code).toBe("NOT_FOUND");
  });

  it("rejects a malformed ID", async () => {
    expect((await caught(setup(payload()).service.get("nope"))).code).toBe("INVALID_INPUT");
  });
});

describe("WalletTransactionRequests.cancel", () => {
  it("cancels a request that has not been signed", async () => {
    const { xaman, service } = setup(payload());
    await service.cancel(UUID);
    expect(xaman.cancelPayload).toHaveBeenCalledWith(UUID);
  });

  it("leaves a signed request alone and keeps following it", async () => {
    const { xaman, service } = setup(signed(), { tx: lookup({}) });
    expect((await service.cancel(UUID)).status).toBe("CONFIRMED");
    expect(xaman.cancelPayload).not.toHaveBeenCalled();
  });
});
