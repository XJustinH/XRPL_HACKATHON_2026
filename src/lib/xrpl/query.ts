import { convertHexToString, isValidClassicAddress, parseNFTokenID, rippleTimeToISOTime } from "xrpl";
import type { AccountNFToken, NFTOffer, Request, RequestResponseMap } from "xrpl";
import type { z } from "zod";

import { NFTokenId, TxHash, XrplAddress } from "@/contracts/common";
import type {
  AccountMintsPage,
  AccountNftsPage,
  AccountSummary,
  ConfirmedLedgerTx,
  LedgerMint,
  LedgerNftOffer,
  LedgerNftOffers,
  LedgerProvenance,
  LedgerTxLookup,
  NftDetails,
  NftOwnership,
  NftOwnershipCheck,
  XrplNetworkStatus,
} from "@/contracts/xrpl";

import { createXrplConnection, type LedgerResponse } from "./client";
import { loadXrplConfig, type XrplConfig } from "./config";
import { XrplServiceError } from "./errors";
import { explorerTxUrl } from "./explorer";

/** What the query service needs from a connection (XrplConnectionManager implements it). */
export interface LedgerReader {
  request<R extends Request>(req: R, operation?: string): Promise<LedgerResponse<RequestResponseMap<R>>>;
  getNetworkStatus(): Promise<XrplNetworkStatus>;
  disconnect(): Promise<void>;
}

const LSF_TRANSFERABLE = 0x00000008;
const ACCOUNT_NFTS_MIN_LIMIT = 20; // rippled accepts 20-400
const ACCOUNT_NFTS_MAX_LIMIT = 400;
const OFFERS_PAGE_LIMIT = 500; // rippled accepts 50-500
const ACCOUNT_TX_MIN_LIMIT = 10;
const ACCOUNT_TX_MAX_LIMIT = 400;
const MAX_OWNERSHIP_SCAN_PAGES = 100; // up to 40,000 NFTs held by one account
const MAX_OFFER_PAGES = 20;

interface CursorState {
  marker: unknown;
  ledgerIndex: number | null;
}

function parseInput(schema: z.ZodType<string>, value: unknown, label: string): string {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new XrplServiceError(
      "INVALID_INPUT",
      `${label}: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  }
  return result.data;
}

function parseAddress(value: unknown): string {
  const address = parseInput(XrplAddress, value, "address");
  if (!isValidClassicAddress(address)) {
    throw new XrplServiceError("INVALID_INPUT", `address: ${address} is not a valid XRPL classic address`);
  }
  return address;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorState {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorState>;
    const ledgerIndex = parsed.ledgerIndex;
    if (parsed.marker === undefined || parsed.marker === null) throw new Error("missing marker");
    if (ledgerIndex !== null && !Number.isInteger(ledgerIndex)) throw new Error("bad ledger index");
    return { marker: parsed.marker, ledgerIndex: ledgerIndex ?? null };
  } catch {
    throw new XrplServiceError("INVALID_INPUT", "cursor is invalid; request the first page again");
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Every read below asks for `ledger_index: "validated"` (or a validated ledger index
 * taken from an earlier page), and the node errors rather than answer from another
 * ledger. Some methods (e.g. nft_sell_offers) do not echo ledger details back, so
 * `validated` falls back to what was requested.
 */
function provenanceOf(
  endpoint: string,
  result: { ledger_index?: number; ledger_hash?: string; validated?: boolean },
  requestedValidated = true,
): LedgerProvenance {
  return {
    endpoint,
    ledgerIndex: result.ledger_index ?? null,
    ledgerHash: result.ledger_hash ?? null,
    validated: result.validated ?? requestedValidated,
    fetchedAt: now(),
  };
}

/**
 * Provenance for a "does not exist" answer, where the node gave no ledger details.
 * Account and offer lookups ask the validated ledger, so their "no" is a
 * validated-ledger answer; a transaction that is not found has no ledger.
 */
function missingProvenance(endpoint: string | undefined, validated: boolean): LedgerProvenance {
  return {
    endpoint: endpoint ?? "unknown",
    ledgerIndex: null,
    ledgerHash: null,
    validated,
    fetchedAt: now(),
  };
}

function decodeUri(hex: string | undefined | null): string | null {
  if (!hex) return null;
  try {
    return convertHexToString(hex);
  } catch {
    return null;
  }
}

function toNftDetails(raw: {
  id: string;
  issuer: string;
  taxon: number;
  serial: number;
  flags: number;
  uriHex?: string | null;
}): NftDetails {
  const nftokenId = raw.id.toUpperCase();
  return {
    nftokenId,
    issuer: raw.issuer,
    taxon: raw.taxon,
    serial: raw.serial,
    flags: raw.flags,
    transferable: (raw.flags & LSF_TRANSFERABLE) !== 0,
    transferFee: parseNFTokenID(nftokenId).TransferFee,
    uri: decodeUri(raw.uriHex),
  };
}

function fromAccountNft(nft: AccountNFToken): NftDetails {
  return toNftDetails({
    id: nft.NFTokenID,
    issuer: nft.Issuer,
    taxon: nft.NFTokenTaxon,
    serial: nft.nft_serial,
    flags: nft.Flags,
    uriHex: nft.URI,
  });
}

function toOffer(raw: NFTOffer, nftokenId: string, side: LedgerNftOffer["side"]): LedgerNftOffer {
  const amount = raw.amount;
  return {
    offerIndex: raw.nft_offer_index.toUpperCase(),
    nftokenId,
    side,
    owner: raw.owner,
    amountDrops: typeof amount === "string" ? amount : null,
    amountIssued:
      typeof amount === "object" && amount !== null
        ? { currency: amount.currency, issuer: amount.issuer, value: amount.value }
        : null,
    destination: raw.destination ?? null,
    expiresAt: raw.expiration === undefined ? null : rippleTimeToISOTime(raw.expiration),
    flags: raw.flags,
  };
}

function hexField(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && /^[0-9A-Fa-f]{64}$/.test(value) ? value.toUpperCase() : null;
}

/** One entry of an API v2 `account_tx` answer (only the fields read here). */
interface AccountTxEntry {
  hash?: string;
  ledger_index?: number;
  close_time_iso?: string;
  validated?: boolean;
  meta?: unknown;
  tx_json?: {
    TransactionType?: string;
    Account?: string;
    Issuer?: string;
    NFTokenTaxon?: number;
    URI?: string;
    Memos?: Array<{ Memo?: { MemoType?: string; MemoData?: string } }>;
  };
}

function isNotFound(error: unknown): error is XrplServiceError {
  return error instanceof XrplServiceError && error.code === "NOT_FOUND";
}

/**
 * Read-only access to the XRPL for the rest of the app (XRPL-007).
 *
 * - Every method validates its inputs and throws XrplServiceError on failure.
 * - Reads use the latest validated ledger, never the open ledger.
 * - Every result carries `provenance`: which node answered and from which ledger.
 */
export class XrplQueryService {
  constructor(
    private readonly config: XrplConfig,
    private readonly rippled: LedgerReader,
    /** Clio node for nft_info and full-history tx lookups; null if disabled. */
    private readonly clio: LedgerReader | null,
  ) {}

  getNetworkStatus(): Promise<XrplNetworkStatus> {
    return this.rippled.getNetworkStatus();
  }

  /**
   * Fee, in drops, a transaction currently needs to get into the open ledger
   * (never below the base fee). For display and quotes only: the signing wallet
   * sets the actual fee. Backs LedgerReadPort.getFeeEstimateDrops.
   */
  async getFeeEstimateDrops(): Promise<string> {
    const { response } = await this.rippled.request({ command: "fee" });
    const { base_fee: base, open_ledger_fee: openLedger } = response.result.drops;
    return BigInt(openLedger) > BigInt(base) ? openLedger : base;
  }

  /**
   * Current account reserves in drops: `baseDrops` to exist, plus `incrementDrops`
   * per owned ledger object (offers, NFT pages, ...). Funds below the total reserve
   * cannot be spent.
   */
  async getReserves(): Promise<{ baseDrops: string; incrementDrops: string }> {
    const { response, endpoint } = await this.rippled.request({ command: "server_state" });
    const ledger = response.result.state.validated_ledger;
    if (!ledger) {
      throw new XrplServiceError("NODE_UNAVAILABLE", "The node has no validated ledger yet", { endpoint });
    }
    return { baseDrops: String(ledger.reserve_base), incrementDrops: String(ledger.reserve_inc) };
  }

  /** Balance and sequence of an account. `exists` is false for a never-funded address. */
  async getAccountInfo(address: string): Promise<AccountSummary> {
    const account = parseAddress(address);
    try {
      const { response, endpoint } = await this.rippled.request({
        command: "account_info",
        account,
        ledger_index: "validated",
      });
      const result = response.result;
      return {
        address: account,
        exists: true,
        balanceDrops: result.account_data.Balance,
        sequence: result.account_data.Sequence,
        ownerCount: result.account_data.OwnerCount,
        provenance: provenanceOf(endpoint, result),
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return {
        address: account,
        exists: false,
        balanceDrops: null,
        sequence: null,
        ownerCount: null,
        provenance: missingProvenance(error.endpoint, true),
      };
    }
  }

  /**
   * One page of NFTs held by an account. Later pages are pinned to the same ledger
   * as the first, so a page set is a consistent snapshot. rippled returns at least
   * 20 per page, so `limit` values below 20 are raised to 20.
   */
  async getAccountNfts(
    address: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AccountNftsPage> {
    const account = parseAddress(address);
    const state = options.cursor ? decodeCursor(options.cursor) : null;
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? 100), ACCOUNT_NFTS_MIN_LIMIT),
      ACCOUNT_NFTS_MAX_LIMIT,
    );
    const { response, endpoint } = await this.rippled.request({
      command: "account_nfts",
      account,
      limit,
      ledger_index: state?.ledgerIndex ?? "validated",
      ...(state ? { marker: state.marker } : {}),
    });
    const result = response.result;
    return {
      address: account,
      items: result.account_nfts.map(fromAccountNft),
      nextCursor:
        result.marker === undefined || result.marker === null
          ? null
          : encodeCursor({ marker: result.marker, ledgerIndex: result.ledger_index ?? null }),
      provenance: provenanceOf(endpoint, result),
    };
  }

  /**
   * NFTs minted by (issued by) `address`, newest first, from validated ledgers only
   * (rippled account_tx). Used to rebuild and verify ticket mappings from the ledger
   * (XRPL-026). Covers only the history the node keeps: `earliestLedger` says where that
   * starts, and `oldestScanned` how far back this page reached, mints or not (XRPL-027).
   */
  async getAccountMints(
    address: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AccountMintsPage> {
    const account = parseAddress(address);
    const state = options.cursor ? decodeCursor(options.cursor) : null;
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? 200), ACCOUNT_TX_MIN_LIMIT),
      ACCOUNT_TX_MAX_LIMIT,
    );
    const { response, endpoint } = await this.rippled.request({
      command: "account_tx",
      account,
      ledger_index_min: -1,
      ledger_index_max: state?.ledgerIndex ?? -1,
      forward: false,
      limit,
      ...(state ? { marker: state.marker } : {}),
    });
    const result = response.result as unknown as {
      transactions: AccountTxEntry[];
      marker?: unknown;
      ledger_index_min?: number;
      ledger_index_max?: number;
      validated?: boolean;
    };
    const items = result.transactions
      .map((entry) => this.toLedgerMint(entry))
      .filter((mint): mint is LedgerMint => mint !== null && mint.issuer === account);
    // Newest first, so the last entry is the oldest one read, whatever its type.
    const oldest = result.transactions.at(-1);
    return {
      address: account,
      items,
      scanned: result.transactions.length,
      earliestLedger: typeof result.ledger_index_min === "number" ? result.ledger_index_min : null,
      oldestScanned:
        oldest && typeof oldest.ledger_index === "number"
          ? { ledgerIndex: oldest.ledger_index, closeTime: oldest.close_time_iso ?? null }
          : null,
      nextCursor:
        result.marker === undefined || result.marker === null
          ? null
          : encodeCursor({ marker: result.marker, ledgerIndex: result.ledger_index_max ?? null }),
      provenance: provenanceOf(endpoint, {
        ledger_index: result.ledger_index_max,
        validated: result.validated,
      }),
    };
  }

  /**
   * Does `address` hold `nftokenId` in the latest validated ledger? Works on any
   * rippled node (no Clio needed). Use it at the gate and before creating a transfer.
   */
  async verifyOwner(nftokenId: string, address: string): Promise<NftOwnershipCheck> {
    const id = parseInput(NFTokenId, nftokenId, "nftokenId");
    const account = parseAddress(address);
    let cursor: CursorState | null = null;
    let provenance: LedgerProvenance | null = null;

    for (let page = 0; page < MAX_OWNERSHIP_SCAN_PAGES; page += 1) {
      let result: RequestResponseMap<{ command: "account_nfts"; account: string }>["result"];
      try {
        const answer = await this.rippled.request({
          command: "account_nfts",
          account,
          limit: ACCOUNT_NFTS_MAX_LIMIT,
          ledger_index: cursor?.ledgerIndex ?? "validated",
          ...(cursor ? { marker: cursor.marker } : {}),
        });
        result = answer.response.result;
        provenance ??= provenanceOf(answer.endpoint, result);
      } catch (error) {
        // An account that does not exist cannot hold anything.
        if (page === 0 && isNotFound(error)) {
          return {
            nftokenId: id,
            address: account,
            owns: false,
            nft: null,
            provenance: missingProvenance(error.endpoint, true),
          };
        }
        throw error;
      }

      const match = result.account_nfts.find((nft) => nft.NFTokenID.toUpperCase() === id);
      if (match) {
        return { nftokenId: id, address: account, owns: true, nft: fromAccountNft(match), provenance };
      }
      if (result.marker === undefined || result.marker === null) {
        return { nftokenId: id, address: account, owns: false, nft: null, provenance };
      }
      cursor = { marker: result.marker, ledgerIndex: result.ledger_index ?? null };
    }

    throw new XrplServiceError(
      "RPC_ERROR",
      `${account} holds more NFTs than can be scanned; use getOwner() with a Clio node instead`,
    );
  }

  /**
   * Current owner of an NFT via Clio `nft_info`. Throws NOT_FOUND if the NFT does
   * not exist and CONFIG_ERROR if Clio is disabled.
   */
  async getOwner(nftokenId: string): Promise<NftOwnership> {
    const id = parseInput(NFTokenId, nftokenId, "nftokenId");
    if (!this.clio) {
      throw new XrplServiceError(
        "CONFIG_ERROR",
        "Direct owner lookup needs a Clio node (XRPL_CLIO_WS_URL). Use verifyOwner() to check a known address instead.",
      );
    }
    const { response, endpoint } = await this.clio.request({
      command: "nft_info",
      nft_id: id,
      ledger_index: "validated",
    });
    const result = response.result;
    return {
      nftokenId: id,
      ownerAddress: result.owner,
      isBurned: result.is_burned,
      nft: toNftDetails({
        id: result.nft_id,
        issuer: result.issuer,
        taxon: result.nft_taxon,
        serial: result.nft_serial,
        flags: result.flags,
        uriHex: result.uri,
      }),
      provenance: provenanceOf(endpoint, result as typeof result & { validated?: boolean }),
    };
  }

  /**
   * All live sell and buy offers for an NFT. An NFT with no offers returns empty
   * lists (rippled reports that case as objectNotFound, which this method absorbs).
   * Expired offers stay listed until someone cancels them: compare `expiresAt`
   * before treating an offer as acceptable.
   */
  async getOffers(nftokenId: string): Promise<LedgerNftOffers> {
    const id = parseInput(NFTokenId, nftokenId, "nftokenId");
    const [sell, buy] = await Promise.all([this.fetchOffers(id, "SELL"), this.fetchOffers(id, "BUY")]);
    return {
      nftokenId: id,
      sellOffers: sell.offers,
      buyOffers: buy.offers,
      provenance: sell.provenance.ledgerIndex !== null ? sell.provenance : buy.provenance,
    };
  }

  /**
   * Status of a transaction. Falls back to Clio (full history) when the rippled
   * node does not know the hash, because fallback nodes may keep only a few hours.
   */
  async getTransaction(hash: string): Promise<LedgerTxLookup> {
    const txHash = parseInput(TxHash, hash, "hash");
    let notFound: XrplServiceError | undefined;
    for (const reader of this.clio ? [this.rippled, this.clio] : [this.rippled]) {
      try {
        return this.toTxLookup(txHash, await reader.request({ command: "tx", transaction: txHash }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        notFound = error;
      }
    }
    return {
      hash: txHash,
      status: "NOT_FOUND",
      engineResult: null,
      succeeded: false,
      transactionType: null,
      account: null,
      ledgerIndex: null,
      closeTime: null,
      nftokenId: null,
      offerIndex: null,
      acceptedSellOfferIndex: null,
      explorerUrl: null,
      provenance: missingProvenance(notFound?.endpoint, false),
    };
  }

  /**
   * Returns the transaction only if it is validated with tesSUCCESS. Throws
   * NOT_VALIDATED (retryable) while it is pending or unknown, and TX_FAILED if it
   * was validated with any other result. Use this before recording anything as confirmed.
   */
  async getValidatedTx(hash: string): Promise<ConfirmedLedgerTx> {
    const tx = await this.getTransaction(hash);
    const endpoint = tx.provenance.endpoint;
    if (tx.status !== "VALIDATED") {
      throw new XrplServiceError(
        "NOT_VALIDATED",
        tx.status === "PENDING"
          ? `Transaction ${tx.hash} is not validated yet`
          : `Transaction ${tx.hash} is not in a validated ledger (yet)`,
        { endpoint },
      );
    }
    if (!tx.succeeded) {
      throw new XrplServiceError(
        "TX_FAILED",
        `Transaction ${tx.hash} was validated with result ${tx.engineResult ?? "unknown"}`,
        { endpoint, rippledError: tx.engineResult ?? undefined },
      );
    }
    if (
      tx.ledgerIndex === null ||
      tx.transactionType === null ||
      tx.account === null ||
      tx.explorerUrl === null
    ) {
      throw new XrplServiceError("UNEXPECTED", `Validated transaction ${tx.hash} is missing ledger details`, {
        endpoint,
      });
    }
    return {
      hash: tx.hash,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: tx.ledgerIndex,
      closeTime: tx.closeTime,
      transactionType: tx.transactionType,
      account: tx.account,
      nftokenId: tx.nftokenId,
      offerIndex: tx.offerIndex,
      acceptedSellOfferIndex: tx.acceptedSellOfferIndex,
      explorerUrl: tx.explorerUrl,
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.rippled.disconnect(), this.clio?.disconnect()]);
  }

  /** A validated NFTokenMint entry as a LedgerMint; null for anything else. */
  private toLedgerMint(entry: AccountTxEntry): LedgerMint | null {
    const tx = entry.tx_json;
    if (entry.validated !== true || tx?.TransactionType !== "NFTokenMint") return null;
    const hash = typeof entry.hash === "string" ? entry.hash.toUpperCase() : null;
    const meta = typeof entry.meta === "object" && entry.meta !== null ? entry.meta : null;
    const engineResult = (meta as { TransactionResult?: unknown } | null)?.TransactionResult;
    if (
      !hash ||
      !TxHash.safeParse(hash).success ||
      typeof tx.Account !== "string" ||
      typeof engineResult !== "string" ||
      typeof entry.ledger_index !== "number"
    ) {
      return null;
    }
    const succeeded = engineResult === "tesSUCCESS";
    return {
      hash,
      ledgerIndex: entry.ledger_index,
      closeTime: entry.close_time_iso ?? null,
      account: tx.Account,
      issuer: tx.Issuer ?? tx.Account,
      engineResult,
      succeeded,
      nftokenId: succeeded ? hexField(meta, "nftoken_id") : null,
      taxon: typeof tx.NFTokenTaxon === "number" ? tx.NFTokenTaxon : null,
      uri: decodeUri(tx.URI),
      memos: (tx.Memos ?? []).map(({ Memo }) => ({
        type: decodeUri(Memo?.MemoType),
        data: decodeUri(Memo?.MemoData),
      })),
      explorerUrl: explorerTxUrl(this.config, hash),
    };
  }

  private toTxLookup(
    txHash: string,
    { response, endpoint }: LedgerResponse<RequestResponseMap<{ command: "tx"; transaction: string }>>,
  ): LedgerTxLookup {
    const result = response.result;
    const meta = typeof result.meta === "object" && result.meta !== null ? result.meta : undefined;
    const validated = result.validated === true;
    const engineResult = meta?.TransactionResult ?? null;
    const ledgerHash = (result as { ledger_hash?: unknown }).ledger_hash;
    return {
      hash: txHash,
      status: validated ? "VALIDATED" : "PENDING",
      engineResult,
      succeeded: validated && engineResult === "tesSUCCESS",
      transactionType: result.tx_json.TransactionType ?? null,
      account: result.tx_json.Account ?? null,
      ledgerIndex: result.ledger_index ?? null,
      closeTime: result.close_time_iso ?? null,
      nftokenId: hexField(meta, "nftoken_id"),
      offerIndex: hexField(meta, "offer_id"),
      acceptedSellOfferIndex:
        result.tx_json.TransactionType === "NFTokenAcceptOffer" ? hexField(result.tx_json, "NFTokenSellOffer") : null,
      explorerUrl: validated ? explorerTxUrl(this.config, txHash) : null,
      provenance: {
        endpoint,
        ledgerIndex: result.ledger_index ?? null,
        ledgerHash: typeof ledgerHash === "string" ? ledgerHash : null,
        validated,
        fetchedAt: now(),
      },
    };
  }

  private async fetchOffers(
    nftokenId: string,
    side: LedgerNftOffer["side"],
  ): Promise<{ offers: LedgerNftOffer[]; provenance: LedgerProvenance }> {
    const offers: LedgerNftOffer[] = [];
    let provenance: LedgerProvenance | null = null;
    let marker: unknown;
    let ledgerIndex: number | "validated" = "validated";

    for (let page = 0; page < MAX_OFFER_PAGES; page += 1) {
      const request = {
        nft_id: nftokenId,
        limit: OFFERS_PAGE_LIMIT,
        ledger_index: ledgerIndex,
        ...(marker === undefined ? {} : { marker }),
      };
      let answer: LedgerResponse<{ result: { offers: NFTOffer[]; marker?: unknown } }>;
      try {
        answer =
          side === "SELL"
            ? await this.rippled.request({ command: "nft_sell_offers", ...request })
            : await this.rippled.request({ command: "nft_buy_offers", ...request });
      } catch (error) {
        if (page === 0 && isNotFound(error)) {
          return { offers: [], provenance: missingProvenance(error.endpoint, true) };
        }
        throw error;
      }
      const result = answer.response.result as typeof answer.response.result & {
        ledger_index?: number;
        ledger_hash?: string;
        validated?: boolean;
      };
      provenance ??= provenanceOf(answer.endpoint, result);
      offers.push(...result.offers.map((offer) => toOffer(offer, nftokenId, side)));
      if (result.marker === undefined || result.marker === null) break;
      marker = result.marker;
      ledgerIndex = result.ledger_index ?? ledgerIndex;
    }

    return { offers, provenance: provenance ?? missingProvenance(undefined, true) };
  }
}

/** Builds a query service from config: rippled endpoints with failover, plus Clio if enabled. */
export function createXrplQueryService(config: XrplConfig = loadXrplConfig()): XrplQueryService {
  const clio = config.clioWsUrl ? createXrplConnection(config, [config.clioWsUrl]) : null;
  return new XrplQueryService(config, createXrplConnection(config), clio);
}

const SHARED_KEY = Symbol.for("xrpl-ticketing.xrplQueryService");

/**
 * Process-wide shared service for route handlers. Stored on globalThis so dev-server
 * hot reloads reuse one WebSocket connection instead of leaking new ones.
 */
export function getXrplQueryService(): XrplQueryService {
  const store = globalThis as unknown as Record<symbol, XrplQueryService | undefined>;
  store[SHARED_KEY] ??= createXrplQueryService();
  return store[SHARED_KEY];
}
