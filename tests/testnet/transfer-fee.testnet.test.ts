import { convertStringToHex, NFTokenMintFlags, parseNFTokenID } from "xrpl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createXrplQueryService } from "@/lib/xrpl";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";

/**
 * XRPL-094: what an NFT transfer fee (a royalty set at mint) does on live XRPL Testnet. This is an
 * investigation with dedicated fixtures, not app behaviour: the app mints tickets with no transfer fee
 * today. See docs/xrpl/transfer-fees.md. Run on demand with `npm run test:testnet`.
 *
 * Three throwaway faucet wallets: an issuer mints one NFT with a 5% fee, sells it to a holder, the
 * holder resells it to a buyer, and the buyer gives it back for free. Balances are read from validated
 * ledgers around each transfer, so every figure below is what the ledger itself did.
 */

const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);

/** 5%, in the ledger's units of 1/100,000 (so 50,000 is the 50% maximum). */
const TRANSFER_FEE = 5000;
const PRIMARY_PRICE = BigInt(1_000_000);
const RESALE_PRICE = BigInt(2_000_000);

let issuer: TestWallet;
let holder: TestWallet;
let buyer: TestWallet;
let nftokenId: string;
/** The transactions of this run, printed at the end as evidence. */
const evidence: string[] = [];

type Submitted = { hash: string; result: string; fee: bigint };

/** Signs and submits with `wallet`, and waits for the validated result. */
async function submit(wallet: TestWallet, tx: Record<string, unknown>): Promise<Submitted> {
  const response = await connection.withClient(
    ({ client }) =>
      client.submitAndWait({ ...tx, Account: wallet.classicAddress } as never, { wallet, autofill: true }),
    "transfer fee fixture",
  );
  const result = response.result as { hash: string; meta?: unknown; tx_json?: { Fee?: string } };
  return {
    hash: result.hash,
    result: (result.meta as { TransactionResult: string }).TransactionResult,
    fee: BigInt(result.tx_json?.Fee ?? "0"),
  };
}

const balanceOf = async (wallet: TestWallet) =>
  BigInt((await ledger.getAccountInfo(wallet.classicAddress)).balanceDrops as string);
const balances = async () => ({
  issuer: await balanceOf(issuer),
  holder: await balanceOf(holder),
  buyer: await balanceOf(buyer),
});

/** `seller` offers the NFT for `amount` and `taker` accepts. Returns each wallet's balance change over the accept. */
async function sell(seller: TestWallet, taker: TestWallet, amount: bigint, destination?: string) {
  const offer = await submit(seller, {
    TransactionType: "NFTokenCreateOffer",
    NFTokenID: nftokenId,
    Amount: amount.toString(),
    Flags: 1, // tfSellNFToken
    ...(destination ? { Destination: destination } : {}),
  });
  expect(offer.result).toBe("tesSUCCESS");
  const offerIndex = (await ledger.getValidatedTx(offer.hash)).offerIndex as string;

  const before = await balances();
  const accept = await submit(taker, { TransactionType: "NFTokenAcceptOffer", NFTokenSellOffer: offerIndex });
  expect(accept.result).toBe("tesSUCCESS");
  const after = await balances();
  return {
    accept,
    change: {
      issuer: after.issuer - before.issuer,
      holder: after.holder - before.holder,
      buyer: after.buyer - before.buyer,
    },
  };
}

beforeAll(async () => {
  issuer = await fundTestWallet(connection, config);
  holder = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
});

afterAll(async () => {
  console.info([`XRPL-094 transfer fee fixture on ${config.network}:`, ...evidence].join("\n  "));
  await ledger.close();
  await connection.disconnect();
});

describe("NFT transfer fees on XRPL Testnet (XRPL-094)", () => {
  it("is fixed at mint and readable from the NFTokenID itself", async () => {
    const mint = await submit(issuer, {
      TransactionType: "NFTokenMint",
      NFTokenTaxon: 94,
      Flags: NFTokenMintFlags.tfTransferable, // a transfer fee is only allowed on a transferable NFT
      TransferFee: TRANSFER_FEE,
      URI: convertStringToHex("https://example.invalid/xrpl-094-transfer-fee-fixture"),
    });
    expect(mint.result).toBe("tesSUCCESS");
    nftokenId = (await ledger.getValidatedTx(mint.hash)).nftokenId as string;
    evidence.push(`mint ${mint.hash}`, `nft ${nftokenId}`);

    expect(parseNFTokenID(nftokenId)).toMatchObject({
      TransferFee: TRANSFER_FEE,
      Issuer: issuer.classicAddress,
    });
    // The app's read service reports it too.
    const held = await ledger.verifyOwner(nftokenId, issuer.classicAddress);
    expect(held.nft).toMatchObject({ transferFee: TRANSFER_FEE, transferable: true });
  });

  it("can't be set on an NFT that isn't transferable", async () => {
    await expect(
      submit(issuer, {
        TransactionType: "NFTokenMint",
        NFTokenTaxon: 94,
        Flags: 0,
        TransferFee: TRANSFER_FEE,
      }),
    ).rejects.toThrow();
  });

  it("charges nothing on the issuer's own sale: the primary sale pays the issuer in full", async () => {
    const { accept, change } = await sell(issuer, holder, PRIMARY_PRICE);
    evidence.push(`primary sale ${accept.hash}`);

    expect(change.issuer).toBe(PRIMARY_PRICE);
    expect((await ledger.verifyOwner(nftokenId, holder.classicAddress)).owns).toBe(true);
  });

  it("takes 5% of a resale from the seller's proceeds and pays it to the issuer", async () => {
    const { accept, change } = await sell(holder, buyer, RESALE_PRICE);
    const royalty = (RESALE_PRICE * BigInt(TRANSFER_FEE)) / BigInt(100_000);
    evidence.push(`resale ${accept.hash}`);

    expect(royalty).toBe(BigInt(100_000)); // 0.1 XRP of the 2 XRP
    expect(change.issuer).toBe(royalty);
    expect(change.holder).toBe(RESALE_PRICE - royalty); // the seller nets 95%
    expect(change.buyer).toBe(-(RESALE_PRICE + accept.fee)); // the buyer pays the price they agreed, plus the network fee
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
  });

  it("charges nothing on a free transfer, so it doesn't stop a sale settled outside the ledger", async () => {
    // A zero-price offer to a named wallet: how a gift works, and how a sale paid for elsewhere would look.
    const { accept, change } = await sell(buyer, holder, BigInt(0), holder.classicAddress);
    evidence.push(`free transfer ${accept.hash}`);

    expect(change.issuer).toBe(BigInt(0));
    expect((await ledger.verifyOwner(nftokenId, holder.classicAddress)).owns).toBe(true);
  });
});
