import { convertStringToHex } from "xrpl";

import type { OfferStatus, PurchaseRequestResult, TransactionRequest } from "@/contracts/xrpl";
import type { LedgerTransaction, NFTOffer, PrismaClient } from "@/generated/prisma/client";
import { requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { explorerNftUrl, explorerTxUrl } from "../explorer";
import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";
import { getWalletReadiness } from "../wallet/readiness";
import type { WalletTransactionRequests } from "../wallet/transaction-requests";

/**
 * Buying a ticket from its primary sell offer (XRPL-031). The buyer accepts the offer with an
 * `NFTokenAcceptOffer` signed in their own Xaman wallet; the ledger swaps the NFT and the XRP
 * atomically. The sale is recorded only from the validated transaction.
 *
 * - Before asking the wallet, the live offer is re-checked on the ledger, and the buyer must
 *   be able to pay. A ticket has one purchase in flight at a time.
 * - A declined, expired, cancelled or failed purchase re-checks the ledger: if the offer is
 *   still there the ticket stays available, otherwise the offer is marked STALE.
 */

export interface PurchaseDeps {
  db: PrismaClient;
  transactions: () => Pick<WalletTransactionRequests, "create" | "get">;
  ledger: () => Pick<
    XrplQueryService,
    "getValidatedTx" | "verifyOwner" | "getOffers" | "getAccountInfo" | "getReserves"
  >;
  config: Pick<XrplConfig, "network" | "explorerUrl" | "networkLabel">;
}

/** What reconciling purchases needs: no balance reads, so any ticket service's deps will do. */
export type ReconcileDeps = Pick<PurchaseDeps, "db" | "transactions"> & {
  ledger: () => Pick<XrplQueryService, "getValidatedTx" | "verifyOwner" | "getOffers">;
};

/** Memo on every purchase the app prepares; the data is the app's offer ID. */
export const PURCHASE_MEMO_TYPE = "xrpl-ticketing/purchase";
/** A purchase hold whose wallet request was never created (e.g. a crash) is released after this. */
const ORPHAN_HOLD_MS = 2 * 60 * 1000;
const MAX_INSTRUCTION_LENGTH = 280;
const MAX_RECONCILE_PER_REQUEST = 20;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STALE_MESSAGE = "This ticket was just sold or taken off sale. Pick another one.";

/** Is the offer still live on the ledger and backed by the seller still holding the NFT? */
async function isLiveOnLedger(deps: ReconcileDeps, offer: NFTOffer): Promise<boolean> {
  if (!offer.offerIndex) return false;
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const onLedger = live.sellOffers.find((o) => o.offerIndex === offer.offerIndex);
  if (
    !onLedger ||
    onLedger.owner !== offer.ownerAddress ||
    onLedger.amountDrops !== offer.amountDrops ||
    onLedger.destination
  ) {
    return false;
  }
  return (await deps.ledger().verifyOwner(offer.nftokenId, offer.ownerAddress)).owns;
}

/**
 * Prepares the buyer's approval for an offer. 403 without a proven wallet · 404 unknown offer
 * or unpublished event · 409 when the ticket is no longer for sale, the buyer is the seller,
 * the buyer cannot pay, or someone is already buying it.
 */
export async function requestPurchase(
  deps: PurchaseDeps,
  input: { session: AuthSession; offerId: string },
): Promise<PurchaseRequestResult> {
  const buyer = requireProvenWallet(input.session);
  const offer = await deps.db.nFTOffer.findUnique({
    where: { id: input.offerId },
    include: {
      ticket: {
        include: {
          event: { select: { title: true, status: true } },
          tier: { select: { name: true } },
        },
      },
    },
  });
  // Resale (XRPL-039) and private offers (XRPL-040) are not sold through this flow yet.
  if (!offer || offer.kind !== "PRIMARY" || !offer.ticket || offer.ticket.event.status !== "PUBLISHED") {
    throw errors.notFound("Offer not found");
  }
  const ticket = offer.ticket;
  if (offer.state !== "ACTIVE" || !offer.offerIndex || ticket.primarySoldAt) {
    throw errors.conflict("This ticket is no longer for sale");
  }
  if (buyer === offer.ownerAddress) throw errors.conflict("You can't buy a ticket from your own wallet");

  const readiness = await getWalletReadiness(deps.ledger(), deps.config, {
    address: buyer,
    requiredDrops: offer.amountDrops,
  });
  if (!readiness.canPurchase) {
    throw errors.conflict(readiness.blockers[0] ?? "This wallet can't pay for the ticket right now");
  }

  // Re-check the live offer: it may have been taken or withdrawn outside the app.
  if (!(await isLiveOnLedger(deps, offer))) {
    await deps.db.nFTOffer.updateMany({
      where: { id: offer.id, state: "ACTIVE" },
      data: { state: "STALE", lastSyncedAt: new Date() },
    });
    throw errors.conflict(STALE_MESSAGE);
  }

  // Settle earlier attempts first: an expired or declined one frees the ticket.
  await reconcileOfferPurchases(deps, offer.id);

  // One purchase in flight per ticket: hold it under a lock on the offer row.
  const hold = await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "NFTOffer" WHERE "id" = ${offer.id}::uuid FOR UPDATE`;
    const current = await tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id }, select: { state: true } });
    if (current.state !== "ACTIVE") throw errors.conflict("This ticket is no longer for sale");
    const inFlight = await tx.ledgerTransaction.findFirst({
      where: { relatedOfferId: offer.id, type: "NFTokenAcceptOffer", status: "PENDING", appliedAt: null },
      select: { account: true },
    });
    if (inFlight) {
      throw errors.conflict(
        inFlight.account === buyer
          ? "You already have a purchase of this ticket waiting in Xaman. Approve or cancel it there first."
          : "Someone is buying this ticket right now. Pick another one, or try again in a few minutes.",
      );
    }
    return tx.ledgerTransaction.create({
      data: {
        type: "NFTokenAcceptOffer",
        network: deps.config.network as LedgerTransaction["network"],
        account: buyer,
        status: "PENDING",
        relatedTicketId: ticket.id,
        relatedOfferId: offer.id,
      },
    });
  });

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "ACCEPT_PRIMARY_OFFER",
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
        Account: buyer,
        NFTokenSellOffer: offer.offerIndex,
        Memos: [
          {
            Memo: {
              MemoType: convertStringToHex(PURCHASE_MEMO_TYPE),
              MemoData: convertStringToHex(offer.id),
            },
          },
        ],
      },
      instruction: truncate(
        `Buy ticket: ${ticket.event.title} — ${ticket.tier.name} #${ticket.serial} for ${formatDropsAsXrp(offer.amountDrops)} XRP`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: offer.id,
    });
  } catch (error) {
    // No sign request exists: release the hold so the ticket can be bought.
    await deps.db.ledgerTransaction.update({
      where: { id: hold.id },
      data: { status: "DROPPED", appliedAt: new Date() },
    });
    throw error;
  }
  await deps.db.ledgerTransaction.update({ where: { id: hold.id }, data: { signRequestRef: request.id } });

  return {
    offerId: offer.id,
    ticketId: ticket.id,
    serial: ticket.serial,
    tierName: ticket.tier.name,
    eventTitle: ticket.event.title,
    amountDrops: offer.amountDrops,
    request,
  };
}

/**
 * Brings one purchase attempt up to date with its sign request and the ledger. Safe to call
 * repeatedly and concurrently: effects are applied once.
 */
export async function reconcilePurchase(deps: ReconcileDeps, attempt: LedgerTransaction): Promise<void> {
  if (attempt.appliedAt || attempt.type !== "NFTokenAcceptOffer" || !attempt.relatedOfferId) return;
  const offer = await deps.db.nFTOffer.findUnique({ where: { id: attempt.relatedOfferId } });
  if (!offer) return;

  if (!attempt.signRequestRef) {
    // A hold whose wallet request was never created: release it once it is clearly orphaned.
    if (Date.now() - attempt.createdAt.getTime() > ORPHAN_HOLD_MS) {
      await deps.db.ledgerTransaction.updateMany({
        where: { id: attempt.id, appliedAt: null, signRequestRef: null },
        data: { status: "DROPPED", appliedAt: new Date() },
      });
    }
    return;
  }

  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(attempt.signRequestRef);
  } catch {
    return; // Wallet service unreachable: try again on the next read.
  }

  switch (request.status) {
    case "PENDING":
    case "OPENED":
      return;
    case "SUBMITTED":
      if (request.txHash) {
        await deps.db.ledgerTransaction.updateMany({
          where: { id: attempt.id, hash: null, appliedAt: null },
          data: { hash: request.txHash },
        });
      }
      return;
    case "CONFIRMED":
      return applyPurchase(deps, offer, attempt, request);
    default:
      return applyFailedPurchase(deps, offer, attempt, request);
  }
}

async function applyPurchase(
  deps: ReconcileDeps,
  offer: NFTOffer,
  attempt: LedgerTransaction,
  request: TransactionRequest,
): Promise<void> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenAcceptOffer" || confirmed.nftokenId !== offer.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} did not transfer NFT ${offer.nftokenId}`);
  }
  if (confirmed.account !== attempt.account) {
    throw new Error(`Purchase ${attempt.id} was signed by ${confirmed.account}, not ${attempt.account}`);
  }
  const buyer = confirmed.account;
  const holding = await deps.ledger().verifyOwner(offer.nftokenId, buyer);
  const now = new Date();
  const soldAt = confirmed.closeTime ? new Date(confirmed.closeTime) : now;

  await deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: attempt.id, appliedAt: null },
      data: {
        hash: confirmed.hash,
        account: buyer,
        status: "VALIDATED_SUCCESS",
        resultCode: confirmed.result,
        ledgerIndex: confirmed.ledgerIndex,
        validatedAt: soldAt,
        appliedAt: now,
      },
    });
    if (claimed.count === 0) return;
    await tx.nFTOffer.updateMany({
      where: { id: offer.id, state: { in: ["ACTIVE", "STALE"] } },
      data: { state: "ACCEPTED", acceptTxHash: confirmed.hash, acceptedByAddress: buyer, lastSyncedAt: now },
    });
    if (offer.ticketId) {
      await tx.ticketNFT.updateMany({
        where: { id: offer.ticketId, primarySoldAt: null },
        data: {
          primarySoldAt: soldAt,
          primarySaleTxHash: confirmed.hash,
          cachedOwnerAddress: holding.owns ? buyer : null,
          ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
          ownerSyncedAt: now,
          ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
        },
      });
    }
  });
}

async function applyFailedPurchase(
  deps: ReconcileDeps,
  offer: NFTOffer,
  attempt: LedgerTransaction,
  request: TransactionRequest,
): Promise<void> {
  const reachedLedger = request.failureReason === "LEDGER_REJECTED";
  const now = new Date();
  const claimed = await deps.db.ledgerTransaction.updateMany({
    where: { id: attempt.id, appliedAt: null },
    data: {
      hash: request.txHash,
      status: reachedLedger ? "VALIDATED_FAILURE" : "DROPPED",
      resultCode: request.engineResult,
      ledgerIndex: request.ledgerIndex,
      validatedAt: reachedLedger ? now : null,
      appliedAt: now,
    },
  });
  if (claimed.count === 0 || offer.state !== "ACTIVE") return;
  // Re-check the ledger: the ticket stays available only if its offer is still live.
  if (!(await isLiveOnLedger(deps, offer))) {
    await deps.db.nFTOffer.updateMany({
      where: { id: offer.id, state: "ACTIVE" },
      data: { state: "STALE", lastSyncedAt: now },
    });
  }
}

/** Reconciles every purchase attempt of one offer that is still in flight. */
export async function reconcileOfferPurchases(deps: ReconcileDeps, offerId: string): Promise<void> {
  const attempts = await deps.db.ledgerTransaction.findMany({
    where: { relatedOfferId: offerId, type: "NFTokenAcceptOffer", appliedAt: null },
    orderBy: { createdAt: "asc" },
  });
  for (const attempt of attempts) await reconcilePurchase(deps, attempt);
}

/** Reconciles an event's purchases in flight (bounded per call), e.g. for the seller's panel. */
export async function reconcileEventPurchases(deps: ReconcileDeps, eventId: string): Promise<void> {
  const attempts = await deps.db.ledgerTransaction.findMany({
    where: {
      type: "NFTokenAcceptOffer",
      appliedAt: null,
      relatedOfferId: { not: null },
      relatedTicketId: { in: (await ticketIdsOf(deps.db, eventId)) ?? [] },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_RECONCILE_PER_REQUEST,
  });
  for (const attempt of attempts) {
    try {
      await reconcilePurchase(deps, attempt);
    } catch (error) {
      console.error(`[purchase] could not reconcile purchase ${attempt.id}`, error);
    }
  }
}

async function ticketIdsOf(db: Pick<PrismaClient, "ticketNFT">, eventId: string): Promise<string[]> {
  const tickets = await db.ticketNFT.findMany({
    where: { eventId, mintStatus: "MINTED", primarySoldAt: null },
    select: { id: true },
  });
  return tickets.map((t) => t.id);
}

/** An offer's state after reconciling its purchases in flight (`GET /api/offers/:id`). */
export async function getOfferStatus(
  deps: ReconcileDeps & { config: Pick<XrplConfig, "explorerUrl"> },
  offerId: string,
): Promise<OfferStatus> {
  const exists = await deps.db.nFTOffer.findUnique({ where: { id: offerId }, select: { id: true } });
  if (!exists) throw errors.notFound("Offer not found");
  await reconcileOfferPurchases(deps, offerId);

  const offer = await deps.db.nFTOffer.findUniqueOrThrow({
    where: { id: offerId },
    include: { ticket: { select: { id: true, serial: true, primarySoldAt: true } } },
  });
  const pending = await deps.db.ledgerTransaction.count({
    where: { relatedOfferId: offerId, type: "NFTokenAcceptOffer", status: "PENDING", appliedAt: null },
  });
  const { ticket, ...row } = offer;
  return {
    offer: toNFTOfferDto(row),
    ticketId: ticket?.id ?? null,
    serial: ticket?.serial ?? null,
    soldAt: ticket?.primarySoldAt ? ticket.primarySoldAt.toISOString() : null,
    purchasePending: pending > 0,
    acceptTxExplorerUrl: offer.acceptTxHash ? explorerTxUrl(deps.config, offer.acceptTxHash) : null,
    nftExplorerUrl: explorerNftUrl(deps.config, offer.nftokenId),
  };
}
