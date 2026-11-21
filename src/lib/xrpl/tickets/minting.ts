import { convertStringToHex, parseNFTokenID } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type {
  EventMints,
  MintFailure,
  MintRequestResult,
  MintTicketView,
  TransactionRequest,
} from "@/contracts/xrpl";
import type { LedgerTransaction, NFTOffer, PrismaClient, TicketNFT } from "@/generated/prisma/client";
import { requireEventOwner, requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toTicketDto, toTicketTierDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { isXrplServiceError, XrplServiceError } from "../errors";
import { explorerNftUrl, explorerTxUrl } from "../explorer";
import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";
import type { WalletTransactionRequests } from "../wallet/transaction-requests";
import { reconcileEventPrimaryOffers, UNSIGNABLE_AFTER_MS } from "../offers/primary";
import { reconcileEventPurchases } from "../offers/purchase";
import { findTicketMint, recordTicketMint } from "./mapping";
import { encodeNftUri, ticketTaxon, TICKET_MEMO_TYPE, TICKET_NFT_FLAGS } from "./metadata";
import { reserveTicketMint } from "./store";
import { isPubliclyReachable } from "./urls";

/**
 * Minting ticket NFTs (XRPL-024). The seller's own wallet signs an NFTokenMint through
 * Xaman; the ticket becomes MINTED only from the validated transaction, and that happens
 * exactly once (LedgerTransaction.appliedAt). Failed attempts are settled from the ledger
 * and free their ticket for a retry, which never mints a second NFT for it (XRPL-027).
 */

export interface MintDeps {
  db: PrismaClient;
  /** Lazy, so listing works even when Xaman is not configured. */
  transactions: () => Pick<WalletTransactionRequests, "create" | "get">;
  ledger: () => Pick<
    XrplQueryService,
    | "getValidatedTx"
    | "getTransaction"
    | "getNetworkStatus"
    | "verifyOwner"
    | "getAccountMints"
    | "getOffers"
    | "getAccountInfo"
    | "getReserves"
  >;
  config: Pick<XrplConfig, "network" | "explorerUrl"> & Partial<Pick<XrplConfig, "networkLabel">>;
  /** Public base URL for metadata URIs (`ticketPublicBaseUrl()`). */
  baseUrl: string;
}

const MAX_INSTRUCTION_LENGTH = 280;
const MAX_RECONCILE_PER_REQUEST = 20;
/** A tier's mints in flight settled before another ticket is reserved (XRPL-027). */
const MAX_SETTLED_PER_RESERVATION = 10;
/** Room for the mint's network fee (about 12 drops) on top of the reserve. */
const FEE_ALLOWANCE_DROPS = BigInt(1000);
/**
 * Ledgers a mint request can be validated in: its LastLedgerSequence is set this far past the
 * validated ledger (XRPL-027). About 15 to 20 minutes at 3 to 4 seconds a ledger, beyond the 10
 * minutes Xaman allows for opening the request, so a seller who opens it late can still sign it.
 */
export const MINT_LEDGER_WINDOW = 300;
/**
 * How far before an attempt its ticket's mint is looked for in the issuer's history: ledger close
 * times and this server's clock may differ a little.
 */
const CLOCK_MARGIN_MS = 10 * 60 * 1000;
/**
 * A node's history must start at least this many ledgers before a lost request's LastLedgerSequence
 * for "no mint in the issuer's history" to count as proof: the request was made after that ledger.
 * Never lower it below MINT_LEDGER_WINDOW, or below a larger window that pending attempts still use.
 */
const HISTORY_COVERAGE_LEDGERS = 1000;

/**
 * For attempts recorded before mints carried a LastLedgerSequence: the app's 15-minute rule for
 * requests (UNSIGNABLE_AFTER_MS) stands in for one.
 */
const unsignable = (since: Date) => Date.now() - since.getTime() > UNSIGNABLE_AFTER_MS;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function toMintTicketView(
  ticket: TicketNFT,
  config: Pick<XrplConfig, "explorerUrl">,
  primaryOffer: Pick<NFTOffer, "id" | "state" | "amountDrops" | "offerIndex"> | null = null,
  mintFailure: MintFailure | null = null,
): MintTicketView {
  return {
    ...toTicketDto(ticket),
    nftExplorerUrl: ticket.nftokenId ? explorerNftUrl(config, ticket.nftokenId) : null,
    mintTxExplorerUrl: ticket.mintTxHash ? explorerTxUrl(config, ticket.mintTxHash) : null,
    primaryOffer: primaryOffer
      ? {
          id: primaryOffer.id,
          state: primaryOffer.state,
          amountDrops: primaryOffer.amountDrops,
          offerIndex: primaryOffer.offerIndex,
        }
      : null,
    mintFailure,
  };
}

/**
 * Why a FAILED ticket's latest attempt produced no NFT, from its settled `LedgerTransaction`
 * (XRPL-027). A FAILED ticket with no attempt on record is one whose request could not be created
 * before attempts were recorded up front.
 */
function mintFailureOf(
  ticket: TicketNFT,
  attempt: LedgerTransaction | undefined,
  config: Pick<XrplConfig, "explorerUrl">,
): MintFailure | null {
  if (ticket.mintStatus !== "FAILED") return null;
  if (!attempt) {
    return {
      reason: "REQUEST_FAILED",
      resultCode: null,
      txExplorerUrl: null,
      at: ticket.updatedAt.toISOString(),
    };
  }
  const at = (attempt.appliedAt ?? attempt.updatedAt).toISOString();
  if (attempt.status === "VALIDATED_FAILURE") {
    return {
      reason: attempt.resultCode === "tecINSUFFICIENT_RESERVE" ? "INSUFFICIENT_RESERVE" : "LEDGER_REJECTED",
      resultCode: attempt.resultCode,
      txExplorerUrl: attempt.hash ? explorerTxUrl(config, attempt.hash) : null,
      at,
    };
  }
  if (attempt.hash)
    return { reason: "NOT_VALIDATED", resultCode: attempt.resultCode, txExplorerUrl: null, at };
  return {
    reason: attempt.signRequestRef ? "NOT_APPROVED" : "REQUEST_FAILED",
    resultCode: null,
    txExplorerUrl: null,
    at,
  };
}

/**
 * The event, if `session` is its owner (Agent A's `requireEventOwner`, XRPL-013):
 * 404 if it does not exist, 403 NOT_EVENT_OWNER otherwise.
 */
async function loadOwnedEvent(db: PrismaClient, session: AuthSession, eventId: string) {
  await requireEventOwner(db, session, eventId);
  return db.event.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true } });
}

/**
 * Reserves the next ticket of a tier and asks the seller's wallet to sign its mint.
 * Only the event's owner may mint, and only with the wallet this session has proven
 * (XRPL-012): that wallet is the issuer, never an address sent by the browser.
 * The NFT is transferable, uses the event's taxon, points at the ticket's metadata URI,
 * and carries a memo with the ticket ID.
 *
 * Before reserving (XRPL-027), the tier's earlier mints in flight are settled, so a ticket freed by
 * a declined or expired request is reused at once, and the wallet must be able to pay for the mint:
 * 409 when it is not activated or can't keep the reserve a new NFT page needs.
 */
export async function requestTicketMint(
  deps: MintDeps,
  input: { session: AuthSession; eventId: string; tierId: string },
): Promise<MintRequestResult> {
  const event = await loadOwnedEvent(deps.db, input.session, input.eventId);
  const issuerAddress = requireProvenWallet(input.session); // 403 WALLET_NOT_VERIFIED
  const tier = await deps.db.ticketTier.findFirst({
    where: { id: input.tierId, eventId: event.id },
    select: { id: true, name: true },
  });
  if (!tier) throw errors.notFound("Ticket tier not found for this event");

  await settleTierMints(deps, tier.id);
  await requireMintReserve(deps, issuerAddress);
  const lastLedgerSequence = await newMintDeadline(deps);

  const { ticket, attempt } = await reserveTicketMint(deps.db, {
    eventId: event.id,
    tierId: tier.id,
    issuerAddress,
    baseUrl: deps.baseUrl,
    network: deps.config.network as XrplNetwork,
    lastLedgerSequence,
  });
  const metadataUri = ticket.metadataUri as string;

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "MINT_TICKET",
      txjson: {
        TransactionType: "NFTokenMint",
        Account: issuerAddress,
        NFTokenTaxon: ticketTaxon(event.id),
        Flags: TICKET_NFT_FLAGS,
        URI: encodeNftUri(metadataUri),
        // Xaman passes a ledger index through unchanged, so a late signature can't mint (XRPL-027).
        LastLedgerSequence: lastLedgerSequence,
        Memos: [
          {
            Memo: { MemoType: convertStringToHex(TICKET_MEMO_TYPE), MemoData: convertStringToHex(ticket.id) },
          },
        ],
      },
      instruction: truncate(
        `Mint ticket NFT: ${event.title} — ${tier.name} #${ticket.serial}`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: ticket.id,
    });
  } catch (error) {
    // No sign request was handed out, so nothing can be signed: settle the attempt and free the
    // ticket now. If that fails too, a reconcile frees it once its LastLedgerSequence has passed.
    await releaseMint(deps, ticket, attempt).catch((releaseError: unknown) => {
      console.error(`[mint] could not free ticket ${ticket.id} after its request failed`, releaseError);
    });
    throw error;
  }

  await deps.db.ledgerTransaction.update({
    where: { id: attempt.id },
    data: { signRequestRef: request.id },
  });

  return {
    ticket: toMintTicketView(ticket, deps.config),
    request,
    metadataPublic: isPubliclyReachable(metadataUri),
  };
}

/** The LastLedgerSequence for a new mint request: `MINT_LEDGER_WINDOW` past the validated ledger. */
async function newMintDeadline(deps: MintDeps): Promise<number> {
  const validated = (await deps.ledger().getNetworkStatus()).validatedLedger;
  if (!validated) {
    throw new XrplServiceError("NODE_UNAVAILABLE", "The XRP Ledger node has no validated ledger yet");
  }
  return validated.index + MINT_LEDGER_WINDOW;
}

/**
 * Whether nothing signed for `attempt` can be validated any more (XRPL-027): the validated ledger is
 * past its LastLedgerSequence, which a pending attempt keeps in `ledgerIndex`. An attempt recorded
 * before mints carried one, or a ticket with no attempt at all, falls back to 15 minutes after `since`.
 */
async function pastDeadline(
  deps: MintDeps,
  attempt: LedgerTransaction | null,
  since: Date,
): Promise<boolean> {
  const last = attempt?.ledgerIndex ?? null;
  if (last === null) return unsignable(since);
  const validated = (await deps.ledger().getNetworkStatus()).validatedLedger?.index;
  return validated !== undefined && validated > last;
}

/** Brings a tier's mints in flight up to date (XRPL-027). Errors are logged: the ledger decides later. */
async function settleTierMints(deps: MintDeps, tierId: string): Promise<void> {
  const inFlight = await deps.db.ticketNFT.findMany({
    where: { tierId, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_SETTLED_PER_RESERVATION,
  });
  for (const { id } of inFlight) {
    try {
      await reconcileTicketMint(deps, id);
    } catch (error) {
      console.error(`[mint] could not reconcile ticket ${id} before reserving another`, error);
    }
  }
}

/**
 * A mint may need a new NFT page, and each page holds one owner-reserve increment (0.2 XRP on Testnet)
 * of the issuer's XRP. Without it spare, plus the fee, the ledger would reject the mint with
 * tecINSUFFICIENT_RESERVE and still charge the fee (XRPL-027). Whether a page is needed depends on
 * the NFT's position among the wallet's NFTs, so a new page is assumed. 409 when the wallet can't
 * cover it, or doesn't exist on the ledger yet.
 */
async function requireMintReserve(deps: MintDeps, issuer: string): Promise<void> {
  const ledger = deps.ledger();
  const [account, reserves] = await Promise.all([ledger.getAccountInfo(issuer), ledger.getReserves()]);
  const network = deps.config.networkLabel ?? "the XRP Ledger";
  if (!account.exists || account.balanceDrops === null) {
    throw errors.conflict(
      `Your wallet isn't activated on ${network} yet. It needs at least ${formatDropsAsXrp(reserves.baseDrops)} XRP (the ledger's base reserve) before it can mint. Fund it and try again.`,
      { reason: "ACCOUNT_NOT_FOUND" },
    );
  }
  const increment = BigInt(reserves.incrementDrops);
  const locked = BigInt(reserves.baseDrops) + increment * BigInt(account.ownerCount ?? 0);
  const balance = BigInt(account.balanceDrops);
  const spendable = balance > locked ? balance - locked : BigInt(0);
  const required = increment + FEE_ALLOWANCE_DROPS;
  if (spendable < required) {
    throw errors.conflict(
      `Not enough XRP to mint: a ticket can need ${formatDropsAsXrp(increment)} XRP of your wallet's reserve for a new NFT page, plus the network fee, and this wallet has ${formatDropsAsXrp(spendable)} XRP spare. Add XRP to the wallet and try again.`,
      {
        reason: "INSUFFICIENT_RESERVE",
        requiredDrops: required.toString(),
        spendableDrops: spendable.toString(),
      },
    );
  }
}

/**
 * Brings one ticket's mint up to date with its sign request and the ledger. Safe to call
 * repeatedly and concurrently: effects are applied once.
 *
 * An attempt whose request can't be followed (XRPL-027) is settled once nothing signed for it can
 * validate any more, that is once the ledger is past its LastLedgerSequence. One never recorded,
 * because the server stopped or failed before handing a request out, frees its ticket. One Xaman no
 * longer has is settled from the ledger: from its transaction if it was signed, else from the
 * issuer's history. So a mint that did happen is recorded, rather than its ticket being minted again.
 */
export async function reconcileTicketMint(deps: MintDeps, ticketId: string): Promise<TicketNFT> {
  const ticket = await deps.db.ticketNFT.findUnique({ where: { id: ticketId } });
  if (!ticket) throw errors.notFound("Ticket not found");
  if (ticket.mintStatus === "MINTED" || ticket.mintStatus === "FAILED") return ticket;

  const attempt = await deps.db.ledgerTransaction.findFirst({
    where: { relatedTicketId: ticketId, type: "NFTokenMint", appliedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!attempt?.signRequestRef) {
    // Tickets reserved before attempts were recorded up front may have no attempt at all.
    const stale = await pastDeadline(deps, attempt, attempt?.createdAt ?? ticket.updatedAt);
    return stale ? releaseMint(deps, ticket, attempt) : ticket;
  }

  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(attempt.signRequestRef);
  } catch (error) {
    if (
      isXrplServiceError(error) &&
      error.code === "NOT_FOUND" &&
      (await pastDeadline(deps, attempt, attempt.createdAt))
    ) {
      return settleFromLedger(deps, ticket, attempt);
    }
    return ticket; // Wallet service unreachable, or the request may still be signed: try again later.
  }

  switch (request.status) {
    case "PENDING":
    case "OPENED":
      return ticket;
    case "SUBMITTED":
      if (request.txHash) {
        await deps.db.ledgerTransaction.updateMany({
          where: { id: attempt.id, hash: null, appliedAt: null },
          data: { hash: request.txHash },
        });
      }
      // Only from PENDING: a concurrent reconcile may already have recorded the outcome.
      await deps.db.ticketNFT.updateMany({
        where: { id: ticketId, mintStatus: "PENDING" },
        data: { mintStatus: "SUBMITTED" },
      });
      return deps.db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    case "CONFIRMED":
      return applyConfirmedMint(deps, ticket, attempt, request.txHash as string);
    default:
      return applyFailedMint(deps, ticket, attempt, request);
  }
}

/** Settles an attempt Xaman no longer has, from the ledger (XRPL-027). */
async function settleFromLedger(
  deps: MintDeps,
  ticket: TicketNFT,
  attempt: LedgerTransaction,
): Promise<TicketNFT> {
  if (attempt.hash) {
    // Signed: its transaction says what happened.
    const lookup = await deps.ledger().getTransaction(attempt.hash);
    if (lookup.status === "VALIDATED") {
      return lookup.succeeded
        ? applyConfirmedMint(deps, ticket, attempt, attempt.hash)
        : applyFailedMint(deps, ticket, attempt, {
            txHash: attempt.hash,
            failureReason: "LEDGER_REJECTED",
            engineResult: lookup.engineResult,
            ledgerIndex: lookup.ledgerIndex,
          });
    }
    if (lookup.status === "PENDING") return ticket;
    // In no ledger this node knows. Past its LastLedgerSequence it never will be, unless the node no
    // longer keeps the ledger it was in: the issuer's history, checked next, settles that.
  }

  // Unsigned as far as the app knows, but Xaman may have lost it after it was signed: look for the
  // ticket's mint in the issuer's history before freeing the ticket.
  const issuer = attempt.account ?? ticket.issuerAddress;
  if (!issuer) return releaseMint(deps, ticket, attempt);
  const found = await findTicketMint(deps, {
    ticketId: ticket.id,
    issuer,
    since: new Date(attempt.createdAt.getTime() - CLOCK_MARGIN_MS),
    // An attempt recorded without a LastLedgerSequence gives no ledger to measure the history against.
    fromLedger: attempt.ledgerIndex === null ? null : attempt.ledgerIndex - HISTORY_COVERAGE_LEDGERS,
  });
  if (found.mint) {
    const outcome = await recordTicketMint(deps, ticket, found.mint);
    if (outcome.kind === "issue") {
      console.warn(
        `[mint] ticket ${ticket.id} has a mint on the ledger that wasn't recorded: ${outcome.issue.detail}`,
      );
    }
    return deps.db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
  }
  if (!found.searched) {
    console.warn(
      `[mint] ticket ${ticket.id}: ${issuer}'s history on this node can't rule out a mint (too busy, or it doesn't reach back to the request); left as it is`,
    );
    return ticket;
  }
  return releaseMint(deps, ticket, attempt);
}

async function applyConfirmedMint(
  deps: MintDeps,
  ticket: TicketNFT,
  pending: LedgerTransaction,
  txHash: string,
): Promise<TicketNFT> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(txHash);
  if (confirmed.transactionType !== "NFTokenMint" || !confirmed.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} is not a mint with an NFTokenID`);
  }
  const issuer = confirmed.account;
  const parsed = parseNFTokenID(confirmed.nftokenId);
  if (parsed.Issuer !== issuer || parsed.Taxon !== ticketTaxon(ticket.eventId)) {
    throw new Error(`NFT ${confirmed.nftokenId} does not match ticket ${ticket.id}`);
  }
  const holding = await deps.ledger().verifyOwner(confirmed.nftokenId, issuer);
  if (holding.owns && holding.nft?.uri !== ticket.metadataUri) {
    throw new Error(`NFT ${confirmed.nftokenId} does not point at ticket ${ticket.id}'s metadata`);
  }

  const now = new Date();
  const mintedAt = confirmed.closeTime ? new Date(confirmed.closeTime) : now;
  return deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: pending.id, appliedAt: null },
      data: {
        hash: confirmed.hash,
        account: issuer,
        status: "VALIDATED_SUCCESS",
        resultCode: confirmed.result,
        ledgerIndex: confirmed.ledgerIndex,
        validatedAt: mintedAt,
        appliedAt: now,
      },
    });
    if (claimed.count === 0) return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });

    // Only a ticket without an NFT is updated: a mapping is never overwritten. If the ticket
    // already has one (e.g. recorded from the ledger by the XRPL-026 reconciler), the
    // mapping report surfaces any disagreement.
    const updated = await tx.ticketNFT.updateMany({
      where: { id: ticket.id, nftokenId: null },
      data: {
        mintStatus: "MINTED",
        nftokenId: confirmed.nftokenId,
        mintTxHash: confirmed.hash,
        mintedAt,
        issuerAddress: issuer,
        cachedOwnerAddress: holding.owns ? issuer : null,
        ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
        ownerSyncedAt: now,
        ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
      },
    });
    const current =
      updated.count === 1 ? null : await tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
    if (!current) {
      await tx.ticketTier.update({
        where: { id: ticket.tierId },
        data: { mintedQuantity: { increment: 1 } },
      });
    } else if (current.nftokenId !== confirmed.nftokenId) {
      console.warn(
        `[mint] ticket ${ticket.id} already maps to ${current.nftokenId}; ${confirmed.nftokenId} not recorded`,
      );
    }
    return current ?? tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
  });
}

async function applyFailedMint(
  deps: MintDeps,
  ticket: TicketNFT,
  pending: LedgerTransaction,
  request: Pick<TransactionRequest, "txHash" | "failureReason" | "engineResult" | "ledgerIndex">,
): Promise<TicketNFT> {
  const reachedLedger = request.failureReason === "LEDGER_REJECTED";
  const now = new Date();
  return deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: pending.id, appliedAt: null },
      data: {
        hash: request.txHash,
        status: reachedLedger ? "VALIDATED_FAILURE" : "DROPPED",
        resultCode: request.engineResult,
        ledgerIndex: request.ledgerIndex,
        validatedAt: reachedLedger ? now : null,
        appliedAt: now,
      },
    });
    // Already applied by a concurrent reconcile; the ticket may even be reserved again.
    if (claimed.count === 0) return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
    await tx.ticketNFT.updateMany({
      where: { id: ticket.id, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
      data: { mintStatus: "FAILED" },
    });
    return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
  });
}

/**
 * Settles an attempt that produced no NFT and frees its ticket for the next mint (XRPL-027): the
 * attempt is claimed once as DROPPED (keeping its hash when it was signed but never validated), and
 * the ticket becomes FAILED. `attempt` is null only for tickets reserved before attempts were
 * recorded up front.
 */
async function releaseMint(
  deps: MintDeps,
  ticket: TicketNFT,
  attempt: LedgerTransaction | null,
): Promise<TicketNFT> {
  const now = new Date();
  return deps.db.$transaction(async (tx) => {
    if (attempt) {
      const claimed = await tx.ledgerTransaction.updateMany({
        where: { id: attempt.id, appliedAt: null },
        // No ledger holds it, so its LastLedgerSequence is cleared from `ledgerIndex`.
        data: { status: "DROPPED", appliedAt: now, ledgerIndex: null },
      });
      if (claimed.count === 0) return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
    }
    await tx.ticketNFT.updateMany({
      where: { id: ticket.id, mintStatus: { in: ["PENDING", "SUBMITTED"] }, nftokenId: null },
      data: { mintStatus: "FAILED" },
    });
    return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
  });
}

/** Every tier of a seller's event with its tickets, after reconciling mints in flight. */
export async function getEventMints(
  deps: MintDeps,
  input: { session: AuthSession; eventId: string },
): Promise<EventMints> {
  const event = await loadOwnedEvent(deps.db, input.session, input.eventId);

  const inFlight = await deps.db.ticketNFT.findMany({
    where: { eventId: event.id, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_RECONCILE_PER_REQUEST,
  });
  for (const { id } of inFlight) {
    try {
      await reconcileTicketMint(deps, id);
    } catch (error) {
      console.error(`[mint] could not reconcile ticket ${id}`, error);
    }
  }

  // Sale listings awaiting the seller's approval (XRPL-029) are brought up to date too.
  await reconcileEventPrimaryOffers(deps, event.id);
  // Purchases in flight (XRPL-031), so the seller sees validated sales.
  await reconcileEventPurchases(deps, event.id);

  const tiers = await deps.db.ticketTier.findMany({
    where: { eventId: event.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      tickets: {
        orderBy: { serial: "asc" },
        // The latest primary sale offer per ticket (XRPL-029).
        include: { offers: { where: { kind: "PRIMARY" }, orderBy: { createdAt: "desc" }, take: 1 } },
      },
    },
  });

  // The latest settled attempt of each FAILED ticket says why it failed (XRPL-027).
  const failedIds = tiers.flatMap((tier) =>
    tier.tickets.filter((t) => t.mintStatus === "FAILED").map((t) => t.id),
  );
  const attempts =
    failedIds.length === 0
      ? []
      : await deps.db.ledgerTransaction.findMany({
          where: { type: "NFTokenMint", relatedTicketId: { in: failedIds }, appliedAt: { not: null } },
          orderBy: { createdAt: "desc" },
        });
  const latestAttempt = new Map<string, LedgerTransaction>();
  for (const attempt of attempts) {
    if (attempt.relatedTicketId && !latestAttempt.has(attempt.relatedTicketId)) {
      latestAttempt.set(attempt.relatedTicketId, attempt);
    }
  }

  return {
    eventId: event.id,
    title: event.title,
    tiers: tiers.map(({ tickets, ...tier }) => ({
      ...toTicketTierDto(tier),
      tickets: tickets.map(({ offers, ...ticket }) =>
        toMintTicketView(
          ticket,
          deps.config,
          offers[0] ?? null,
          mintFailureOf(ticket, latestAttempt.get(ticket.id), deps.config),
        ),
      ),
    })),
  };
}
