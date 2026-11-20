// @vitest-environment node
import { RippledError, TimeoutError, type Request } from "xrpl";
import { describe, expect, it } from "vitest";

import {
  AccountNftsPage,
  AccountSummary,
  ConfirmedLedgerTx,
  LedgerNftOffers,
  LedgerTxLookup,
  NftOwnership,
  NftOwnershipCheck,
} from "@/contracts/xrpl";

import { XrplConnectionManager } from "../client";
import { loadXrplConfig } from "../config";
import { XrplServiceError } from "../errors";
import { XrplQueryService } from "../query";
import { fakeNetwork } from "./fake-client";

const RIPPLED = "wss://rippled.test/";
const CLIO = "wss://clio.test/";
const config = loadXrplConfig({});

// NFTokenID from the XRPL docs: flags 11 (burnable | only XRP | transferable), transfer fee 314.
const NFT_ID = "000B013A95F14B0044F78A264E41713C64B5F89242540EE208C3098E00000D65";
const OTHER_NFT_ID = "00080000B4F4AFC5FBCBD76873F18006173D2193467D3EE70000099B00000001";
const ISSUER = "rNCFjuvKkMSvp5mjavdty6ERYDrNkyZkR7";
const OWNER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const BUYER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const URI_HEX = "697066733A2F2F626166792D7469636B65742D31"; // "ipfs://bafy-ticket-1"

const notFound = (token: string) => () => {
  throw new RippledError(`not found: ${token}`, { error: token });
};

type Handler = (req: Request & Record<string, unknown>) => unknown;

function setup(rippledHandler: Handler, clioHandler?: Handler) {
  const rippledNet = fakeNetwork({ [RIPPLED]: { handler: rippledHandler as (req: Request) => unknown } });
  const clioNet = fakeNetwork({
    [CLIO]: { handler: (clioHandler ?? notFound("unknownCmd")) as (req: Request) => unknown },
  });
  const rippled = new XrplConnectionManager(config, [RIPPLED], rippledNet.factory);
  const clio = clioHandler ? new XrplConnectionManager(config, [CLIO], clioNet.factory) : null;
  const sent = () =>
    rippledNet.created
      .flatMap((client) => client.requests)
      .filter((req) => req.command !== "server_info") as Array<Request & Record<string, unknown>>;
  return { service: new XrplQueryService(config, rippled, clio), sent };
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

const accountNft = (id: string, extra: Record<string, unknown> = {}) => ({
  Flags: 11,
  Issuer: ISSUER,
  NFTokenID: id,
  NFTokenTaxon: 7,
  nft_serial: 3429,
  URI: URI_HEX,
  ...extra,
});

describe("input validation", () => {
  const { service } = setup(() => ({}));

  it("rejects malformed addresses, including a bad checksum", async () => {
    expect((await caught(service.getAccountInfo("not-an-address"))).code).toBe("INVALID_INPUT");
    expect((await caught(service.getAccountInfo("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYf"))).message).toMatch(
      /not a valid/,
    );
  });

  it("rejects malformed NFT IDs and hashes before touching the network", async () => {
    expect((await caught(service.verifyOwner("1234", OWNER))).code).toBe("INVALID_INPUT");
    expect((await caught(service.getOffers("zz"))).code).toBe("INVALID_INPUT");
    expect((await caught(service.getTransaction("abc"))).code).toBe("INVALID_INPUT");
  });

  it("rejects a tampered cursor", async () => {
    expect((await caught(service.getAccountNfts(OWNER, { cursor: "garbage" }))).code).toBe("INVALID_INPUT");
  });
});

describe("getReserves", () => {
  it("reads the base and per-object reserve in drops from the validated ledger", async () => {
    const { service, sent } = setup(() => ({
      result: { state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000, seq: 9 } } },
    }));
    expect(await service.getReserves()).toEqual({ baseDrops: "1000000", incrementDrops: "200000" });
    expect(sent()[0]).toMatchObject({ command: "server_state" });
  });

  it("reports a node without a validated ledger as unavailable", async () => {
    const { service } = setup(() => ({ result: { state: {} } }));
    expect((await caught(service.getReserves())).code).toBe("NODE_UNAVAILABLE");
  });
});

describe("getFeeEstimateDrops", () => {
  const fee = (open_ledger_fee: string) => () => ({
    result: { drops: { base_fee: "10", median_fee: "5000", minimum_fee: "10", open_ledger_fee } },
  });

  it("returns the open-ledger fee when the network is busy", async () => {
    expect(await setup(fee("12")).service.getFeeEstimateDrops()).toBe("12");
  });

  it("never returns less than the base fee", async () => {
    expect(await setup(fee("0")).service.getFeeEstimateDrops()).toBe("10");
  });

  it("surfaces node failures as typed errors", async () => {
    const { service } = setup(() => {
      throw new TimeoutError("slow");
    });
    expect((await caught(service.getFeeEstimateDrops())).code).toBe("TIMEOUT");
  });
});

describe("getAccountInfo", () => {
  it("returns balance, sequence and provenance from the validated ledger", async () => {
    const { service, sent } = setup(() => ({
      result: {
        account_data: { Balance: "99999988", Sequence: 42, OwnerCount: 3 },
        ledger_index: 500,
        ledger_hash: "ABC",
        validated: true,
      },
    }));
    const info = await service.getAccountInfo(OWNER);
    AccountSummary.parse(info); // contract conformance
    expect(info).toMatchObject({
      address: OWNER,
      exists: true,
      balanceDrops: "99999988",
      sequence: 42,
      ownerCount: 3,
      provenance: { endpoint: RIPPLED, ledgerIndex: 500, ledgerHash: "ABC", validated: true },
    });
    expect(sent()[0]).toMatchObject({ command: "account_info", ledger_index: "validated" });
  });

  it("reports a never-funded address as not existing instead of failing", async () => {
    const { service } = setup(notFound("actNotFound"));
    expect(await service.getAccountInfo(OWNER)).toMatchObject({ exists: false, balanceDrops: null });
  });
});

describe("getAccountNfts", () => {
  it("decodes NFT details and returns an opaque cursor pinned to the same ledger", async () => {
    const { service, sent } = setup((req) =>
      req.marker === undefined
        ? {
            result: {
              account: OWNER,
              account_nfts: [accountNft(NFT_ID)],
              marker: "PAGE2",
              ledger_index: 900,
              validated: true,
            },
          }
        : { result: { account: OWNER, account_nfts: [], ledger_index: 900, validated: true } },
    );

    const first = await service.getAccountNfts(OWNER, { limit: 5 });
    AccountNftsPage.parse(first); // contract conformance
    expect(first.items).toEqual([
      {
        nftokenId: NFT_ID,
        issuer: ISSUER,
        taxon: 7,
        serial: 3429,
        flags: 11,
        transferable: true,
        transferFee: 314,
        uri: "ipfs://bafy-ticket-1",
      },
    ]);
    expect(first.provenance).toMatchObject({ ledgerIndex: 900, validated: true });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.getAccountNfts(OWNER, { cursor: first.nextCursor as string });
    expect(second.nextCursor).toBeNull();
    // limit is clamped to rippled's minimum, and page 2 is read from the same ledger as page 1.
    expect(sent()[0]).toMatchObject({ limit: 20, ledger_index: "validated" });
    expect(sent()[1]).toMatchObject({ marker: "PAGE2", ledger_index: 900 });
  });
});

describe("verifyOwner", () => {
  it("finds the NFT on a later page", async () => {
    const { service } = setup((req) =>
      req.marker === undefined
        ? {
            result: {
              account_nfts: [accountNft(OTHER_NFT_ID)],
              marker: "M1",
              ledger_index: 10,
              validated: true,
            },
          }
        : { result: { account_nfts: [accountNft(NFT_ID.toLowerCase())], ledger_index: 10, validated: true } },
    );
    const check = await service.verifyOwner(NFT_ID.toLowerCase(), OWNER);
    NftOwnershipCheck.parse(check); // contract conformance
    expect(check).toMatchObject({
      nftokenId: NFT_ID,
      address: OWNER,
      owns: true,
      nft: { nftokenId: NFT_ID },
    });
    expect(check.provenance).toMatchObject({ ledgerIndex: 10, validated: true });
  });

  it("says false when the account does not hold it", async () => {
    const { service } = setup(() => ({
      result: { account_nfts: [accountNft(OTHER_NFT_ID)], ledger_index: 10, validated: true },
    }));
    expect(await service.verifyOwner(NFT_ID, OWNER)).toMatchObject({ owns: false, nft: null });
  });

  it("says false for an account that does not exist", async () => {
    const { service } = setup(notFound("actNotFound"));
    expect(await service.verifyOwner(NFT_ID, OWNER)).toMatchObject({ owns: false });
  });

  it("surfaces node failures instead of guessing", async () => {
    const { service } = setup(() => {
      throw new TimeoutError("slow");
    });
    expect((await caught(service.verifyOwner(NFT_ID, OWNER))).code).toBe("TIMEOUT");
  });
});

describe("getOwner (Clio nft_info)", () => {
  it("returns the current owner and burn state", async () => {
    const { service } = setup(
      () => ({}),
      () => ({
        result: {
          nft_id: NFT_ID,
          ledger_index: 77,
          owner: BUYER,
          is_burned: false,
          flags: 8,
          transfer_fee: 314,
          issuer: ISSUER,
          nft_taxon: 7,
          nft_serial: 3429,
          uri: URI_HEX,
          validated: true,
        },
      }),
    );
    const ownership = await service.getOwner(NFT_ID);
    NftOwnership.parse(ownership); // contract conformance
    expect(ownership).toMatchObject({
      nftokenId: NFT_ID,
      ownerAddress: BUYER,
      isBurned: false,
      nft: { transferable: true, transferFee: 314, uri: "ipfs://bafy-ticket-1" },
      provenance: { endpoint: CLIO, ledgerIndex: 77, validated: true },
    });
  });

  it("throws NOT_FOUND for an unknown NFT", async () => {
    const { service } = setup(() => ({}), notFound("objectNotFound"));
    expect((await caught(service.getOwner(NFT_ID))).code).toBe("NOT_FOUND");
  });

  it("explains that Clio is required when it is disabled", async () => {
    const { service } = setup(() => ({}));
    expect((await caught(service.getOwner(NFT_ID))).code).toBe("CONFIG_ERROR");
  });
});

describe("getOffers", () => {
  it('normalises sell offers and treats "no offers" as an empty list', async () => {
    const { service } = setup((req) => {
      if (req.command === "nft_buy_offers") return notFound("objectNotFound")();
      return {
        result: {
          nft_id: NFT_ID,
          offers: [
            { amount: "2500000", flags: 1, nft_offer_index: OFFER_INDEX.toLowerCase(), owner: OWNER },
            {
              amount: "0",
              flags: 1,
              nft_offer_index: OFFER_INDEX,
              owner: OWNER,
              destination: BUYER,
              expiration: 800000000,
            },
          ],
          ledger_index: 321,
          validated: true,
        },
      };
    });
    const offers = await service.getOffers(NFT_ID);
    LedgerNftOffers.parse(offers); // contract conformance
    expect(offers.buyOffers).toEqual([]);
    expect(offers.sellOffers).toEqual([
      {
        offerIndex: OFFER_INDEX,
        nftokenId: NFT_ID,
        side: "SELL",
        owner: OWNER,
        amountDrops: "2500000",
        amountIssued: null,
        destination: null,
        expiresAt: null,
        flags: 1,
      },
      {
        offerIndex: OFFER_INDEX,
        nftokenId: NFT_ID,
        side: "SELL",
        owner: OWNER,
        amountDrops: "0",
        amountIssued: null,
        destination: BUYER,
        expiresAt: "2025-05-08T06:13:20.000Z",
        flags: 1,
      },
    ]);
    expect(offers.provenance).toMatchObject({ ledgerIndex: 321 });
  });

  it("collects every page of offers", async () => {
    const offer = (n: number) => ({
      amount: String(n),
      flags: 1,
      nft_offer_index: OFFER_INDEX,
      owner: OWNER,
    });
    const { service, sent } = setup((req) => {
      if (req.command === "nft_buy_offers") return notFound("objectNotFound")();
      return req.marker === undefined
        ? { result: { offers: [offer(1)], marker: "NEXT", ledger_index: 5 } }
        : { result: { offers: [offer(2)] } };
    });
    const offers = await service.getOffers(NFT_ID);
    expect(offers.sellOffers.map((o) => o.amountDrops)).toEqual(["1", "2"]);
    expect(sent().filter((r) => r.command === "nft_sell_offers")[1]).toMatchObject({
      marker: "NEXT",
      ledger_index: 5,
    });
  });

  it("marks offers as validated-ledger data even though rippled does not echo ledger details", async () => {
    // Live rippled answers nft_sell_offers with only { nft_id, offers }.
    const { service, sent } = setup((req) =>
      req.command === "nft_sell_offers"
        ? {
            result: {
              nft_id: NFT_ID,
              offers: [{ amount: "1", flags: 1, nft_offer_index: OFFER_INDEX, owner: OWNER }],
            },
          }
        : notFound("objectNotFound")(),
    );
    const offers = await service.getOffers(NFT_ID);
    expect(offers.provenance).toMatchObject({ endpoint: RIPPLED, ledgerIndex: null, validated: true });
    expect(sent().every((req) => req.ledger_index === "validated")).toBe(true);
  });

  it("keeps non-XRP offers visible but without a drops price", async () => {
    const { service } = setup((req) =>
      req.command === "nft_sell_offers"
        ? {
            result: {
              offers: [
                {
                  amount: { currency: "USD", issuer: ISSUER, value: "10" },
                  flags: 1,
                  nft_offer_index: OFFER_INDEX,
                  owner: OWNER,
                },
              ],
            },
          }
        : notFound("objectNotFound")(),
    );
    const [offer] = (await service.getOffers(NFT_ID)).sellOffers;
    expect(offer).toMatchObject({ amountDrops: null, amountIssued: { currency: "USD", value: "10" } });
  });
});

const txResult = (extra: Record<string, unknown>) => ({
  result: {
    hash: TX_HASH,
    tx_json: { TransactionType: "NFTokenMint", Account: OWNER },
    meta: { TransactionResult: "tesSUCCESS", nftoken_id: NFT_ID },
    ledger_index: 1234,
    ledger_hash: "LH",
    close_time_iso: "2026-11-20T17:00:00Z",
    validated: true,
    ...extra,
  },
});

describe("getTransaction / getValidatedTx", () => {
  it("reports a validated successful mint with its NFTokenID and explorer link", async () => {
    const { service } = setup(() => txResult({}));
    const tx = await service.getTransaction(TX_HASH.toLowerCase());
    LedgerTxLookup.parse(tx); // contract conformance
    expect(tx).toMatchObject({
      hash: TX_HASH,
      status: "VALIDATED",
      engineResult: "tesSUCCESS",
      succeeded: true,
      transactionType: "NFTokenMint",
      account: OWNER,
      ledgerIndex: 1234,
      nftokenId: NFT_ID,
      offerIndex: null,
      explorerUrl: `https://testnet.xrpl.org/transactions/${TX_HASH}`,
      provenance: { ledgerIndex: 1234, ledgerHash: "LH", validated: true },
    });
    ConfirmedLedgerTx.parse(await service.getValidatedTx(TX_HASH)); // contract conformance
    expect(await service.getValidatedTx(TX_HASH)).toEqual({
      hash: TX_HASH,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: 1234,
      closeTime: "2026-11-20T17:00:00Z",
      transactionType: "NFTokenMint",
      account: OWNER,
      nftokenId: NFT_ID,
      offerIndex: null,
      explorerUrl: `https://testnet.xrpl.org/transactions/${TX_HASH}`,
    });
  });

  it("picks up the offer index created by NFTokenCreateOffer", async () => {
    const { service } = setup(() =>
      txResult({
        tx_json: { TransactionType: "NFTokenCreateOffer", Account: OWNER },
        meta: { TransactionResult: "tesSUCCESS", offer_id: OFFER_INDEX },
      }),
    );
    expect(await service.getTransaction(TX_HASH)).toMatchObject({ offerIndex: OFFER_INDEX, nftokenId: null });
  });

  it("never treats a pending transaction as confirmed", async () => {
    const { service } = setup(() => txResult({ validated: false }));
    const tx = await service.getTransaction(TX_HASH);
    expect(tx).toMatchObject({ status: "PENDING", succeeded: false, explorerUrl: null });
    const error = await caught(service.getValidatedTx(TX_HASH));
    expect(error.code).toBe("NOT_VALIDATED");
    expect(error.retryable).toBe(true);
  });

  it("reports a validated failure as TX_FAILED with the engine result", async () => {
    const { service } = setup(() => txResult({ meta: { TransactionResult: "tecNO_PERMISSION" } }));
    expect(await service.getTransaction(TX_HASH)).toMatchObject({ status: "VALIDATED", succeeded: false });
    const error = await caught(service.getValidatedTx(TX_HASH));
    expect(error.code).toBe("TX_FAILED");
    expect(error.rippledError).toBe("tecNO_PERMISSION");
    expect(error.retryable).toBe(false);
  });

  it("returns not_found when no node knows the hash", async () => {
    const { service } = setup(notFound("txnNotFound"), notFound("txnNotFound"));
    expect(await service.getTransaction(TX_HASH)).toMatchObject({ status: "NOT_FOUND", succeeded: false });
    LedgerTxLookup.parse(await service.getTransaction(TX_HASH)); // contract conformance
    expect((await caught(service.getValidatedTx(TX_HASH))).code).toBe("NOT_VALIDATED");
  });

  it("falls back to Clio history when the rippled node has pruned the transaction", async () => {
    const { service } = setup(notFound("txnNotFound"), () => txResult({}));
    const tx = await service.getTransaction(TX_HASH);
    expect(tx).toMatchObject({ status: "VALIDATED", succeeded: true, provenance: { endpoint: CLIO } });
  });

  it('does not swallow node outages as "not found"', async () => {
    const { service } = setup(() => {
      throw new TimeoutError("slow");
    });
    expect((await caught(service.getTransaction(TX_HASH))).code).toBe("TIMEOUT");
  });
});
