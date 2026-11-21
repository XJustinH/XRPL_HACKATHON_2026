import { z } from "zod";

import { AppId, Drops, IsoDateTime, NFTokenId, OfferIndex, pageOf, TxHash, XrplAddress } from "./common";
import { NFTOfferDto, OfferState, TicketDto, TicketTierDto, XrplNetwork } from "./entities";

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
 * - PROVIDER_UNAVAILABLE: the wallet signing provider (Xaman) could not be reached or failed (retryable).
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
  "PROVIDER_UNAVAILABLE",
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

/** A memo on a transaction, decoded from hex to text (null when absent or not text). */
export const LedgerMemo = z.object({ type: z.string().nullable(), data: z.string().nullable() });
export type LedgerMemo = z.infer<typeof LedgerMemo>;

/**
 * An NFTokenMint from a validated ledger, as found in an issuer's history (rippled
 * account_tx). Failed mints are listed too: only `succeeded` mints created an NFT.
 */
export const LedgerMint = z.object({
  hash: TxHash,
  ledgerIndex: z.number().int(),
  closeTime: IsoDateTime.nullable(),
  /** Account that signed the mint. */
  account: XrplAddress,
  /** Issuer of the NFT: the signer, unless it minted for another account (`Issuer`). */
  issuer: XrplAddress,
  engineResult: z.string(),
  succeeded: z.boolean(),
  /** The minted NFT (from the transaction metadata); null for failed mints. */
  nftokenId: NFTokenId.nullable(),
  taxon: z.number().int().nullable(),
  /** The mint's URI decoded from hex, or null. */
  uri: z.string().nullable(),
  memos: z.array(LedgerMemo),
  explorerUrl: z.string(),
});
export type LedgerMint = z.infer<typeof LedgerMint>;

/**
 * One page of NFTs minted by (issued by) an account, newest first. Later pages are pinned
 * to the first page's validated ledger range. `scanned` counts every transaction read on
 * this page, mint or not.
 */
export const AccountMintsPage = pageOf(LedgerMint).extend({
  address: XrplAddress,
  scanned: z.number().int().nonnegative(),
  provenance: LedgerProvenance,
});
export type AccountMintsPage = z.infer<typeof AccountMintsPage>;

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
  /**
   * Sell offer taken by an NFTokenAcceptOffer (its `NFTokenSellOffer`, also set in a brokered sale).
   * Null for other transactions, and when an NFT's owner accepted a buy offer.
   */
  acceptedSellOfferIndex: OfferIndex.nullable(),
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
  acceptedSellOfferIndex: OfferIndex.nullable(),
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

// ---------------------------------------------------------------------------
// Wallet sign requests (XRPL-011; transaction kinds arrive with XRPL-014)
// ---------------------------------------------------------------------------

/** What the wallet is asked to sign. SIGN_IN proves control of an account and is never submitted. */
export const SignRequestKind = z.enum(["SIGN_IN"]);
export type SignRequestKind = z.infer<typeof SignRequestKind>;

/**
 * Lifecycle of a wallet sign request.
 * - PENDING: waiting for the user.
 * - OPENED: opened in the wallet but not answered yet.
 * - SIGNED: approved in the wallet.
 * - REJECTED: declined in the wallet.
 * - EXPIRED: not answered in time.
 * - CANCELLED: withdrawn by the app.
 */
export const SignRequestStatus = z.enum(["PENDING", "OPENED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"]);
export type SignRequestStatus = z.infer<typeof SignRequestStatus>;

/** Statuses that will not change any more. */
export const FINAL_SIGN_REQUEST_STATUSES: readonly SignRequestStatus[] = [
  "SIGNED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
];

/** Body of `POST /api/wallet/sign-requests`. */
export const CreateSignRequestBody = z.object({ kind: SignRequestKind });
export type CreateSignRequestBody = z.infer<typeof CreateSignRequestBody>;

export const SignRequest = z.object({
  /** The wallet provider's request ID (Xaman payload UUID). */
  id: z.uuid(),
  kind: SignRequestKind,
  status: SignRequestStatus,
  /** Opens the request in Xaman: the app on mobile, a QR page on desktop. */
  signUrl: z.url(),
  /** QR code image to scan with Xaman from another device. */
  qrPngUrl: z.url(),
  expiresAt: IsoDateTime.nullable(),
  /** Signing account once SIGNED. A public address, never a secret. */
  account: XrplAddress.nullable(),
  /** Network the wallet signed on, once SIGNED (e.g. "TESTNET"). */
  walletNetwork: z.string().nullable(),
  /** False when the wallet signed on a different network than the app uses; null until SIGNED. */
  networkMatches: z.boolean().nullable(),
});
export type SignRequest = z.infer<typeof SignRequest>;

// ---------------------------------------------------------------------------
// Transaction approval requests (XRPL-014)
// ---------------------------------------------------------------------------

/**
 * Why the app asks the wallet to sign a transaction. Each purpose allows exactly one
 * transaction type, built on the server by the issue that owns it (e.g. mint: XRPL-024).
 * TEST is a no-op AccountSet for checking the approval flow during development.
 */
export const TransactionPurpose = z.enum([
  "TEST",
  "MINT_TICKET",
  "CREATE_PRIMARY_OFFER",
  "ACCEPT_PRIMARY_OFFER",
]);
export type TransactionPurpose = z.infer<typeof TransactionPurpose>;

/**
 * Lifecycle of a transaction approval.
 * - PENDING / OPENED: waiting for the user in Xaman.
 * - REJECTED / EXPIRED / CANCELLED: never signed, so nothing was sent. Retry with a new request.
 * - SUBMITTED: signed and sent to the network; waiting for a validated ledger.
 * - CONFIRMED: validated with tesSUCCESS. The only success state.
 * - FAILED: see `failureReason`.
 */
export const TransactionRequestStatus = z.enum([
  "PENDING",
  "OPENED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
]);
export type TransactionRequestStatus = z.infer<typeof TransactionRequestStatus>;

/** Statuses that will not change any more. */
export const FINAL_TRANSACTION_REQUEST_STATUSES: readonly TransactionRequestStatus[] = [
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "CONFIRMED",
  "FAILED",
];

/**
 * Why a signed transaction FAILED.
 * - LEDGER_REJECTED: validated with a "tec" result. The fee was charged; nothing else changed.
 * - NETWORK_REJECTED: refused before reaching a ledger ("tem" or "tef" results). Nothing was charged.
 * - NOT_VALIDATED_IN_TIME: its LastLedgerSequence passed without validation. Nothing was charged.
 * - WRONG_NETWORK: the wallet signed on a different network than the app uses.
 */
export const TransactionFailureReason = z.enum([
  "LEDGER_REJECTED",
  "NETWORK_REJECTED",
  "NOT_VALIDATED_IN_TIME",
  "WRONG_NETWORK",
]);
export type TransactionFailureReason = z.infer<typeof TransactionFailureReason>;

export const TransactionRequest = z.object({
  /** The wallet provider's request ID (Xaman payload UUID). */
  id: z.uuid(),
  purpose: TransactionPurpose,
  /** App record the request is for (e.g. a ticket ID), if any. */
  reference: z.string().nullable(),
  status: TransactionRequestStatus,
  transactionType: z.string(),
  /** Account that must sign. */
  account: XrplAddress,
  /** What the user is asked to approve, as shown in Xaman. */
  instruction: z.string(),
  signUrl: z.url(),
  qrPngUrl: z.url(),
  expiresAt: IsoDateTime.nullable(),
  /** Set once signed. */
  txHash: TxHash.nullable(),
  /** Ledger result once validated, or the network's refusal code. */
  engineResult: z.string().nullable(),
  ledgerIndex: z.number().int().nullable(),
  /** Explorer link for transactions that reached a validated ledger. */
  explorerUrl: z.string().nullable(),
  failureReason: TransactionFailureReason.nullable(),
});
export type TransactionRequest = z.infer<typeof TransactionRequest>;

/** Body of `POST /api/wallet/transaction-requests` (development only). */
export const CreateTestTransactionBody = z.object({
  purpose: z.literal("TEST"),
  account: XrplAddress,
});
export type CreateTestTransactionBody = z.infer<typeof CreateTestTransactionBody>;

// ---------------------------------------------------------------------------
// Ticket NFT metadata and identity (XRPL-022)
// ---------------------------------------------------------------------------

/** Version marker inside ticket metadata JSON. Bump when the shape changes. */
export const TICKET_METADATA_SCHEMA = "xrpl-ticketing/ticket@1";

/**
 * Public metadata for a ticket NFT, served at the URI written into the NFT at mint
 * (XRPL-023). Follows the XLS-24 layout (name, description, image, collection, attributes)
 * so wallets and explorers can display it, plus a `ticket` block that ties the NFT to
 * exactly one ticket record. It never contains attendee information: buyers and holders
 * are not named, and ownership is only ever read from the ledger.
 */
export const TicketNftMetadata = z.object({
  schema: z.literal(TICKET_METADATA_SCHEMA),
  nftType: z.literal("ticket.v1"),
  name: z.string().min(1),
  description: z.string(),
  image: z.url(),
  collection: z.object({ name: z.string(), family: z.string() }),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })),
  ticket: z.object({
    /** App ticket record (TicketNFT.id). One NFT per ticket record, one record per NFT. */
    ticketId: AppId,
    eventId: AppId,
    tierId: AppId,
    /** 1-based serial within the tier. */
    serial: z.number().int().positive(),
    /** Seller account that mints (issues) the NFT. */
    issuer: XrplAddress,
    network: XrplNetwork,
  }),
  event: z.object({
    title: z.string(),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime.nullable(),
    venue: z.string(),
    city: z.string(),
  }),
  tier: z.object({ name: z.string(), priceDrops: Drops }),
});
export type TicketNftMetadata = z.infer<typeof TicketNftMetadata>;

// ---------------------------------------------------------------------------
// Ticket minting (XRPL-024)
// ---------------------------------------------------------------------------

/**
 * Body of `POST /api/events/:id/mints`: mint the next ticket of a tier. The issuer is the
 * session's proven wallet (XRPL-012), so the browser never names it.
 */
export const CreateMintBody = z.object({ tierId: AppId });
export type CreateMintBody = z.infer<typeof CreateMintBody>;

/** A ticket record plus explorer links once its NFT exists. */
/** A ticket's latest primary sale offer, as the seller's panel shows it (XRPL-029). */
export const PrimaryOfferSummary = z.object({
  id: AppId,
  state: OfferState,
  amountDrops: Drops,
  offerIndex: OfferIndex.nullable(),
});
export type PrimaryOfferSummary = z.infer<typeof PrimaryOfferSummary>;

export const MintTicketView = TicketDto.extend({
  nftExplorerUrl: z.string().nullable(),
  mintTxExplorerUrl: z.string().nullable(),
  /** Latest primary sale offer for this ticket (XRPL-029), or null if never listed. */
  primaryOffer: PrimaryOfferSummary.nullable(),
});
export type MintTicketView = z.infer<typeof MintTicketView>;

/** Response of `POST /api/events/:id/mints`. Render `request` with the approval UI. */
export const MintRequestResult = z.object({
  ticket: MintTicketView,
  request: TransactionRequest,
  /** False when the metadata URI is not reachable from the internet (e.g. localhost). */
  metadataPublic: z.boolean(),
});
export type MintRequestResult = z.infer<typeof MintRequestResult>;

/** Response of `GET /api/events/:id/mints`: every tier with its ticket records. */
export const EventMints = z.object({
  eventId: AppId,
  title: z.string(),
  tiers: z.array(TicketTierDto.extend({ tickets: z.array(MintTicketView) })),
});
export type EventMints = z.infer<typeof EventMints>;

// ---------------------------------------------------------------------------
// NFT-to-ticket mapping reconciliation (XRPL-026)
// ---------------------------------------------------------------------------

/** Why a ticket's mapping and the ledger disagree. The app never overwrites a mapping to fix one. */
export const MintMappingProblem = z.enum([
  /** A validated mint for this event names a ticket the app has no record of. */
  "TICKET_NOT_FOUND",
  /** A ticket's validated mint does not carry the ticket's metadata URI. */
  "URI_MISMATCH",
  /** A ticket's validated mint does not use the event's taxon. */
  "TAXON_MISMATCH",
  /** The ledger shows a mint for a ticket that is already mapped to a different NFT. */
  "TICKET_HAS_OTHER_NFT",
  /** The NFT is already mapped to another ticket; the database rejects duplicates. */
  "NFT_MAPPED_TO_OTHER_TICKET",
  /** A minted ticket's recorded mint transaction shows a different NFT or issuer. */
  "MINT_TX_MISMATCH",
  /** A minted ticket's recorded mint transaction could not be confirmed as a validated success. */
  "MINT_TX_NOT_VALIDATED",
]);
export type MintMappingProblem = z.infer<typeof MintMappingProblem>;

export const MintMappingIssue = z.object({
  problem: MintMappingProblem,
  ticketId: AppId.nullable(),
  serial: z.number().int().nullable(),
  nftokenId: NFTokenId.nullable(),
  txHash: TxHash.nullable(),
  detail: z.string(),
});
export type MintMappingIssue = z.infer<typeof MintMappingIssue>;

/** Response of `POST /api/events/:id/mints/reconcile`. */
export const MintMappingReport = z.object({
  eventId: AppId,
  /** Issuer accounts whose validated mint history was read. */
  issuers: z.array(XrplAddress),
  /** Validated ticket mints for this event found in that history. */
  mintsFound: z.number().int().nonnegative(),
  /** Tickets whose NFT mapping this run rebuilt from the ledger. */
  recorded: z.array(AppId),
  /** Minted tickets whose mapping matches their validated mint transaction. */
  verified: z.number().int().nonnegative(),
  issues: z.array(MintMappingIssue),
  /** False when an issuer's history was longer than one run reads. */
  complete: z.boolean(),
  checkedAt: IsoDateTime,
});
export type MintMappingReport = z.infer<typeof MintMappingReport>;

// ---------------------------------------------------------------------------
// Primary sale offers (XRPL-029)
// ---------------------------------------------------------------------------

/** Body of `POST /api/tickets/:id/primary-offers`. The price is always the ticket tier's price. */
export const CreatePrimaryOfferBody = z.object({}).strict();
export type CreatePrimaryOfferBody = z.infer<typeof CreatePrimaryOfferBody>;

/** Response of `POST /api/tickets/:id/primary-offers`. Render `request` with the approval UI. */
export const PrimaryOfferRequestResult = z.object({
  offer: NFTOfferDto,
  request: TransactionRequest,
});
export type PrimaryOfferRequestResult = z.infer<typeof PrimaryOfferRequestResult>;

/**
 * A live primary sell offer a buyer can accept: Agent C's `OfferPort.PrimaryOffer` fields plus
 * the ticket it sells. Only ACTIVE offers on unsold minted tickets are listed.
 */
export const PrimaryOfferListing = z.object({
  offerId: AppId,
  offerIndex: OfferIndex,
  nftokenId: NFTokenId,
  sellerAddress: XrplAddress,
  amountDrops: Drops,
  tierId: AppId,
  tierName: z.string(),
  ticketId: AppId,
  serial: z.number().int().positive(),
  expiresAt: IsoDateTime.nullable(),
});
export type PrimaryOfferListing = z.infer<typeof PrimaryOfferListing>;

/** Response of `GET /api/events/:id/primary-offers`: live primary offers, cheapest first. */
export const EventPrimaryOffers = z.object({
  eventId: AppId,
  offers: z.array(PrimaryOfferListing),
});
export type EventPrimaryOffers = z.infer<typeof EventPrimaryOffers>;

// ---------------------------------------------------------------------------
// Primary purchases (XRPL-031)
// ---------------------------------------------------------------------------

/** Body of `POST /api/offers/:id/accept-intent`. The buyer is the session's proven wallet. */
export const AcceptOfferBody = z.object({}).strict();
export type AcceptOfferBody = z.infer<typeof AcceptOfferBody>;

/** Response of `POST /api/offers/:id/accept-intent`. Render `request` with the approval UI. */
export const PurchaseRequestResult = z.object({
  offerId: AppId,
  ticketId: AppId,
  serial: z.number().int().positive(),
  tierName: z.string(),
  eventTitle: z.string(),
  amountDrops: Drops,
  request: TransactionRequest,
});
export type PurchaseRequestResult = z.infer<typeof PurchaseRequestResult>;

/**
 * Response of `GET /api/offers/:id`: the offer after reconciling purchases in flight. A sale is
 * recorded only from a validated `NFTokenAcceptOffer`.
 */
export const OfferStatus = z.object({
  offer: NFTOfferDto,
  ticketId: AppId.nullable(),
  serial: z.number().int().positive().nullable(),
  /** When the ticket's primary sale validated, or null. */
  soldAt: IsoDateTime.nullable(),
  /** A purchase is waiting for its buyer's approval or for the ledger. */
  purchasePending: z.boolean(),
  acceptTxExplorerUrl: z.string().nullable(),
  nftExplorerUrl: z.string(),
});
export type OfferStatus = z.infer<typeof OfferStatus>;

// ---------------------------------------------------------------------------
// Ticket ownership (XRPL-028)
// ---------------------------------------------------------------------------

/**
 * Who holds a ticket's NFT, as read from a validated ledger.
 * - VERIFIED: the owner was read from a validated ledger.
 * - PENDING: it could not be verified right now (ledger unreachable, or the NFT moved to a wallet
 *   the app has not seen). Never treat a PENDING ticket as owned by anyone.
 * - NOT_MINTED: the ticket has no NFT yet. BURNED: the NFT no longer exists.
 */
export const TicketOwnershipStatus = z.enum(["VERIFIED", "PENDING", "NOT_MINTED", "BURNED"]);
export type TicketOwnershipStatus = z.infer<typeof TicketOwnershipStatus>;

/** Response of `GET /api/tickets/:id/ownership`. */
export const TicketOwnership = z.object({
  ticketId: AppId,
  nftokenId: NFTokenId.nullable(),
  status: TicketOwnershipStatus,
  /** The verified owner; null unless VERIFIED. */
  ownerAddress: XrplAddress.nullable(),
  /** Validated ledger the answer came from. */
  ledgerIndex: z.number().int().nullable(),
  checkedAt: IsoDateTime,
  /** The owner the app had on record before this check. */
  previousOwnerAddress: XrplAddress.nullable(),
  /** True when the verified owner differs from the one on record (a sale or transfer happened). */
  changed: z.boolean(),
  /** True when the requester's proven wallet is the verified owner. */
  ownedByViewer: z.boolean(),
  /** Why ownership is PENDING or BURNED, for the buyer-facing message. */
  detail: z.string().nullable(),
  nftExplorerUrl: z.string().nullable(),
});
export type TicketOwnership = z.infer<typeof TicketOwnership>;
