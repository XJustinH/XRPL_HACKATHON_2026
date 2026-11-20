/**
 * Live Testnet smoke test for the XRPL read/query service (XRPL-007).
 *
 *   npm run xrpl:dev-wallet -- seller
 *   npm run xrpl:dev-wallet -- buyer
 *   npm run xrpl:smoke-read
 *
 * Developer tooling only. It signs with the throwaway dev wallets so that there
 * is real ledger data to read back: it mints one test NFT, lists it for 1 XRP,
 * has the buyer accept, and checks that every read (ownership, offers,
 * transaction status) matches what actually happened. This is NOT the product
 * mint/purchase flow, which uses wallet approval (XRPL-014/024/031).
 */
import { readFileSync } from "node:fs";

import {
  convertStringToHex,
  NFTokenCreateOfferFlags,
  NFTokenMintFlags,
  Wallet,
  type SubmittableTransaction,
} from "xrpl";

import {
  createXrplConnection,
  createXrplQueryService,
  explorerNftUrl,
  isXrplServiceError,
  loadXrplConfig,
  type XrplConfig,
} from "@/lib/xrpl";
import { describeError, loadLocalEnv } from "./env";

const WALLET_FILE = ".xrpl-dev-wallets.local.json";
const PRICE_DROPS = "1000000"; // 1 XRP

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function loadDevWallet(label: string): Wallet {
  let records: Array<{ label: string; seed: string }>;
  try {
    records = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
  } catch {
    throw new Error(
      `No ${WALLET_FILE}. Run: npm run xrpl:dev-wallet -- seller && npm run xrpl:dev-wallet -- buyer`,
    );
  }
  const record = records.find((entry) => entry.label === label);
  if (!record) throw new Error(`No dev wallet labelled "${label}". Run: npm run xrpl:dev-wallet -- ${label}`);
  return Wallet.fromSeed(record.seed);
}

/** Polls `read` until `done` accepts the value (nodes can trail each other by a ledger). */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 10): Promise<T> {
  let last: T | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (error) {
      if (!(isXrplServiceError(error) && error.code === "NOT_FOUND")) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (last !== undefined) return last;
  throw lastError;
}

async function checkStructuredFailure(config: XrplConfig): Promise<void> {
  // Nothing listens on this port, so the connection must fail with a typed, retryable error.
  const unreachable = createXrplQueryService(
    loadXrplConfig({
      XRPL_WS_URL: "wss://127.0.0.1:1/",
      XRPL_WS_FALLBACK_URLS: "none",
      XRPL_CLIO_WS_URL: "none",
      XRPL_CONNECT_TIMEOUT_MS: "1500",
      XRPL_EXPLORER_URL: config.explorerUrl,
    }),
  );
  try {
    await unreachable.getNetworkStatus();
    check("unreachable node returns a structured failure", false, "unexpectedly connected");
  } catch (error) {
    const ok = isXrplServiceError(error) && error.code === "NODE_UNAVAILABLE" && error.retryable;
    check("unreachable node returns a structured failure", ok, describeError(error));
  } finally {
    await unreachable.close();
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadXrplConfig();
  const seller = loadDevWallet("seller");
  const buyer = loadDevWallet("buyer");
  const writer = createXrplConnection(config);
  const query = createXrplQueryService(config);

  const submit = async (tx: SubmittableTransaction, wallet: Wallet) => {
    const response = await writer.withClient(
      ({ client }) => client.submitAndWait(tx, { wallet, autofill: true }),
      tx.TransactionType,
    );
    return response.result.hash;
  };

  try {
    const status = await query.getNetworkStatus();
    check(
      "network status",
      status.networkId === config.expectedNetworkId,
      `${status.endpoint}, ledger ${status.validatedLedger?.index}`,
    );

    const feeDrops = await query.getFeeEstimateDrops();
    check("fee estimate is a positive drops amount", /^[1-9][0-9]*$/.test(feeDrops), `${feeDrops} drops`);

    // --- Setup: mint and list one test NFT -----------------------------------
    const mintHash = await submit(
      {
        TransactionType: "NFTokenMint",
        Account: seller.classicAddress,
        NFTokenTaxon: 0,
        Flags: NFTokenMintFlags.tfTransferable,
        URI: convertStringToHex("https://example.invalid/xrpl-007-smoke.json"),
      },
      seller,
    );
    const mint = await query.getTransaction(mintHash);
    check(
      "mint tx read back as validated tesSUCCESS",
      mint.succeeded,
      `${mint.engineResult}, ledger ${mint.ledgerIndex}`,
    );
    const nftokenId = mint.nftokenId;
    check("mint tx exposes the new NFTokenID", nftokenId !== null, nftokenId ?? "missing");
    if (!nftokenId) throw new Error("Cannot continue without an NFTokenID");

    const offerHash = await submit(
      {
        TransactionType: "NFTokenCreateOffer",
        Account: seller.classicAddress,
        NFTokenID: nftokenId,
        Amount: PRICE_DROPS,
        Flags: NFTokenCreateOfferFlags.tfSellNFToken,
      },
      seller,
    );
    const offerTx = await query.getValidatedTx(offerHash);
    check(
      "getValidatedTx confirms the sell offer",
      offerTx.offerIndex !== null,
      offerTx.offerIndex ?? "missing",
    );

    // --- Reads while the seller holds it -------------------------------------
    const sellerCheck = await query.verifyOwner(nftokenId, seller.classicAddress);
    check(
      "verifyOwner: seller holds the NFT",
      sellerCheck.owns,
      `ledger ${sellerCheck.provenance.ledgerIndex}`,
    );
    check(
      "NFT details decoded",
      sellerCheck.nft?.transferable === true &&
        sellerCheck.nft.uri === "https://example.invalid/xrpl-007-smoke.json",
    );

    const ownerBefore = await eventually(
      () => query.getOwner(nftokenId),
      (o) => o.ownerAddress === seller.classicAddress,
    );
    check(
      "getOwner (Clio) names the seller",
      ownerBefore.ownerAddress === seller.classicAddress,
      `ledger ${ownerBefore.provenance.ledgerIndex}`,
    );

    const offers = await eventually(
      () => query.getOffers(nftokenId),
      (o) => o.sellOffers.length > 0,
    );
    const listed = offers.sellOffers.find((offer) => offer.offerIndex === offerTx.offerIndex);
    check(
      "getOffers lists the 1 XRP sell offer",
      listed?.amountDrops === PRICE_DROPS && listed.owner === seller.classicAddress,
    );

    const page = await query.getAccountNfts(seller.classicAddress, { limit: 400 });
    check(
      "getAccountNfts includes the NFT",
      page.items.some((nft) => nft.nftokenId === nftokenId),
      `${page.items.length} on first page`,
    );

    const buyerInfo = await query.getAccountInfo(buyer.classicAddress);
    check(
      "getAccountInfo: buyer is funded",
      buyerInfo.exists && BigInt(buyerInfo.balanceDrops ?? "0") > BigInt(PRICE_DROPS),
    );

    const provenances = [sellerCheck, ownerBefore, offers, page, buyerInfo, mint].map(
      (read) => read.provenance,
    );
    check(
      "every read carries validated-ledger provenance",
      provenances.every((p) => p.validated && p.endpoint.startsWith("wss://")),
      `ledgers ${provenances.map((p) => p.ledgerIndex ?? "not reported").join(", ")}`,
    );

    // --- Transfer, then read again -------------------------------------------
    const acceptHash = await submit(
      {
        TransactionType: "NFTokenAcceptOffer",
        Account: buyer.classicAddress,
        NFTokenSellOffer: offerTx.offerIndex as string,
      },
      buyer,
    );
    const accept = await query.getValidatedTx(acceptHash);
    check("accept tx confirmed and names the NFT", accept.nftokenId === nftokenId);

    const buyerCheck = await query.verifyOwner(nftokenId, buyer.classicAddress);
    const sellerAfter = await query.verifyOwner(nftokenId, seller.classicAddress);
    check("verifyOwner: buyer now holds it, seller does not", buyerCheck.owns && !sellerAfter.owns);

    const ownerAfter = await eventually(
      () => query.getOwner(nftokenId),
      (o) => o.ownerAddress === buyer.classicAddress,
    );
    check("getOwner (Clio) follows the transfer", ownerAfter.ownerAddress === buyer.classicAddress);

    const offersAfter = await eventually(
      () => query.getOffers(nftokenId),
      (o) => o.sellOffers.length === 0,
    );
    check("accepted offer is gone", offersAfter.sellOffers.length === 0);

    const unknown = await query.getTransaction("0".repeat(64));
    check("unknown hash reported as NOT_FOUND", unknown.status === "NOT_FOUND");

    await checkStructuredFailure(config);

    console.log("\nLedger evidence (Testnet):");
    console.log(`  NFT     ${explorerNftUrl(config, nftokenId)}`);
    console.log(`  mint    ${mint.explorerUrl}`);
    console.log(`  offer   ${offerTx.explorerUrl}`);
    console.log(`  accept  ${accept.explorerUrl}`);
  } finally {
    await Promise.all([writer.disconnect(), query.close()]);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
