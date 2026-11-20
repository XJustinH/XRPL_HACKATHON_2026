import { z } from "zod";

import { Drops, IsoDateTime, NFTokenId, OfferIndex, pageOf, TxHash, XrplAddress } from "./common";
import { XrplNetwork } from "./entities";

/**
 * XRPL contract types. Owner: Agent B.
 * Safe to import from server and client code. Ledger primitives (Drops, XrplAddress,
 * NFTokenId, OfferIndex, TxHash) live in ./common and are reused here.
 */

/**
 * Error codes thrown by the XRPL service layer (`XrplServiceError.code`).
 *
 * - CONFIG_ERROR: environment is misconfigured, including any Mainnet setting.
 * - INVALID_INPUT: malformed address/ID/hash, or a request the ledger rejected as malformed.
 * - NOT_FOUND: the account/transaction/object is not on the validated ledger.
 * - TIMEOUT: the node did not answer in time (retryable).
 * - NODE_UNAVAILABLE: no configured node could be reached, or it is busy/not synced (retryable).
 * - WRONG_NETWORK: a node reported a network other than the configured one. Fatal.
 * - NOT_VALIDATED: the transaction is not (yet) in a validated ledger (retryable).
 * - TX_FAILED: the transaction was validated with a result other than tesSUCCESS.
 * - RPC_ERROR: any other ledger error response.
 * - UNEXPECTED: an error the service could not classify.
 */
export const XrplErrorCode = z.enum([
  "CONFIG_ERROR",
  "INVALID_INPUT",
  "NOT_FOUND",
  "TIMEOUT",
  "NODE_UNAVAILABLE",
  "WRONG_NETWORK",
  "NOT_VALIDATED",
  "TX_FAILED",
  "RPC_ERROR",
  "UNEXPECTED",
]);
export type XrplErrorCode = z.infer<typeof XrplErrorCode>;

/** Serialisable error shape. Never contains secrets. */
export const XrplErrorBody = z.object({
  code: XrplErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type XrplErrorBody = z.infer<typeof XrplErrorBody>;

/** Health of the XRPL node in use (`GET /api/xrpl/status`). */
export const XrplNetworkStatus = z.object({
  network: XrplNetwork,
  networkId: z.number().int(),
  endpoint: z.string(),
  serverState: z.string(),
  buildVersion: z.string().nullable(),
  validatedLedger: z
    .object({
      index: z.number().int(),
      hash: z.string(),
      ageSeconds: z.number(),
    })
    .nullable(),
  checkedAt: IsoDateTime,
});
export type XrplNetworkStatus = z.infer<typeof XrplNetworkStatus>;

// ---------------------------------------------------------------------------
// Read/query service (XRPL-007)
// ---------------------------------------------------------------------------

/**
 * Where a ledger answer came from. Every read result carries one, so callers can
 * show or store which validated ledger a fact was true in.
 */
export const LedgerProvenance = z.object({
  endpoint: z.string(),
  /**
   * Ledger the data was read from; null if the node did not say (rippled's
   * nft_sell_offers/nft_buy_offers never do). For Clio nft_info it is the ledger
   * in which the NFT's current state was set.
   */
  ledgerIndex: z.number().int().nullable(),
  ledgerHash: z.string().nullable(),
  /**
   * True when the data reflects a validated ledger. Account, NFT and offer reads
   * always query the validated ledger. For a transaction this is the
   * transaction's own validated flag (false while pending or not found).
   */
  validated: z.boolean(),
  fetchedAt: IsoDateTime,
});
export type LedgerProvenance = z.infer<typeof LedgerProvenance>;

/** Static properties of an NFT, decoded from the ledger. */
export const NftDetails = z.object({
  nftokenId: NFTokenId,
  issuer: XrplAddress,
  taxon: z.number().int(),
  serial: z.number().int(),
  flags: z.number().int(),
  /** lsfTransferable: holders can sell or gift it to anyone (required for resale). */
  transferable: z.boolean(),
  /** Issuer's resale fee in 1/100,000 units (0-50000, i.e. 0%-50%). */
  transferFee: z.number().int(),
  /** Metadata URI decoded from hex, or null if the NFT has none. */
  uri: z.string().nullable(),
});
export type NftDetails = z.infer<typeof NftDetails>;

/** One page of NFTs held by an account. Pass `nextCursor` back as `cursor` for the next page. */
export const AccountNftsPage = pageOf(NftDetails).extend({
  address: XrplAddress,
  provenance: LedgerProvenance,
});
export type AccountNftsPage = z.infer<typeof AccountNftsPage>;

/** Answer to "does this address hold this NFT right now?" (rippled account_nfts). */
export const NftOwnershipCheck = z.object({
  nftokenId: NFTokenId,
  address: XrplAddress,
  owns: z.boolean(),
  /** NFT details when `owns` is true. */
  nft: NftDetails.nullable(),
  provenance: LedgerProvenance,
});
export type NftOwnershipCheck = z.infer<typeof NftOwnershipCheck>;

/** Current owner of an NFT, looked up directly (Clio nft_info). */
export const NftOwnership = z.object({
  nftokenId: NFTokenId,
  /** Current owner, or the last owner if the NFT was burned. */
  ownerAddress: XrplAddress,
  isBurned: z.boolean(),
  nft: NftDetails,
  provenance: LedgerProvenance,
});
export type NftOwnership = z.infer<typeof NftOwnership>;

/** A live NFTokenOffer on the ledger (not the app's NFTOfferDto record). */
export const LedgerNftOffer = z.object({
  offerIndex: OfferIndex,
  nftokenId: NFTokenId,
  side: z.enum(["SELL", "BUY"]),
  owner: XrplAddress,
  /** Price in drops; null when the offer is priced in a non-XRP token. */
  amountDrops: Drops.nullable(),
  /** Set instead of amountDrops for non-XRP offers (not used by this app). */
  amountIssued: z.object({ currency: z.string(), issuer: z.string(), value: z.string() }).nullable(),
  /** Only this account may accept the offer (private sale or gift). */
  destination: XrplAddress.nullable(),
  /** When the offer stops being acceptable; null if it never expires. */
  expiresAt: IsoDateTime.nullable(),
  flags: z.number().int(),
});
export type LedgerNftOffer = z.infer<typeof LedgerNftOffer>;

export const LedgerNftOffers = z.object({
  nftokenId: NFTokenId,
  sellOffers: z.array(LedgerNftOffer),
  buyOffers: z.array(LedgerNftOffer),
  provenance: LedgerProvenance,
});
export type LedgerNftOffers = z.infer<typeof LedgerNftOffers>;

/**
 * A transaction looked up by hash.
 * - VALIDATED: in a validated ledger; `engineResult` is final.
 * - PENDING: the node has it but it is not validated yet; `engineResult` is provisional.
 * - NOT_FOUND: no node knows it (not submitted yet, still propagating, or never applied).
 */
export const LedgerTxLookup = z.object({
  hash: TxHash,
  status: z.enum(["VALIDATED", "PENDING", "NOT_FOUND"]),
  engineResult: z.string().nullable(),
  /** True only for a validated transaction with result tesSUCCESS. */
  succeeded: z.boolean(),
  transactionType: z.string().nullable(),
  account: XrplAddress.nullable(),
  ledgerIndex: z.number().int().nullable(),
  closeTime: IsoDateTime.nullable(),
  /** NFT minted or transferred (NFTokenMint / NFTokenAcceptOffer). */
  nftokenId: NFTokenId.nullable(),
  /** Offer created (NFTokenCreateOffer, or NFTokenMint with an Amount). */
  offerIndex: OfferIndex.nullable(),
  /** Explorer link, only for validated transactions. */
  explorerUrl: z.string().nullable(),
  provenance: LedgerProvenance,
});
export type LedgerTxLookup = z.infer<typeof LedgerTxLookup>;

/** A transaction proven final and successful: the only state that may be shown as confirmed. */
export const ConfirmedLedgerTx = z.object({
  hash: TxHash,
  validated: z.literal(true),
  result: z.literal("tesSUCCESS"),
  ledgerIndex: z.number().int(),
  closeTime: IsoDateTime.nullable(),
  transactionType: z.string(),
  account: XrplAddress,
  nftokenId: NFTokenId.nullable(),
  offerIndex: OfferIndex.nullable(),
  explorerUrl: z.string(),
});
export type ConfirmedLedgerTx = z.infer<typeof ConfirmedLedgerTx>;

/** Basic account state, e.g. to check a wallet is funded before asking it to sign. */
export const AccountSummary = z.object({
  address: XrplAddress,
  /** False for an address that has never been funded (no account on the ledger). */
  exists: z.boolean(),
  balanceDrops: Drops.nullable(),
  sequence: z.number().int().nullable(),
  ownerCount: z.number().int().nullable(),
  provenance: LedgerProvenance,
});
export type AccountSummary = z.infer<typeof AccountSummary>;
