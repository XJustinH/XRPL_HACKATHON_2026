import { convertStringToHex } from "xrpl";

import type { OfferCancelRequestResult, TransactionRequest } from "@/contracts/xrpl";
import type { LedgerTransaction, NFTOffer } from "@/generated/prisma/client";
import { requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import { formatDropsAsXrp } from "../format";
import { syncOfferWithLedger } from "./ledger-check";
import { reconcileOfferCreation, type OfferDeps } from "./primary";

/**
 * Cancelling an open offer (XRPL-042). The wallet that made a sell offer (a holder's resale listing,
 * private sale or gift, or an organiser's primary listing) withdraws it with an `NFTokenCancelOffer`
 * signed in its own Xaman wallet.
 *
 * - Only the offer's owner can cancel it. Anyone else gets 404, so private sales and gifts stay private.
 * - The offer stays ACTIVE until the cancellation validates. It becomes CANCELLED only from the
 *   validated transaction, signed by the owner, once the offer is gone from the ledger. Declined,
 *   expired or failed cancellations leave it as it was.
 * - Until then someone can still accept it. The ledger settles whichever comes first.
 * - Once cancelled, the ticket can be offered again.
 */

export type CancelReconcileDeps = Pick<OfferDeps, "db" | "transactions" | "ledger">;

/** Memo on every cancellation the app prepares; the data is the app's offer ID. */
export const CANCEL_MEMO_TYPE = "xrpl-ticketing/cancel";
/** A cancellation hold whose wallet request was never created (e.g. a crash) is released after this. */
const ORPHAN_HOLD_MS = 2 * 60 * 1000;
const MAX_INSTRUCTION_LENGTH = 280;

const KIND_LABELS: Record<NFTOffer["kind"], string> = {
  PRIMARY: "ticket listing",
  RESALE: "resale listing",
  PRIVATE: "private sale",
  GIFT: "ticket gift",
};

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Asks the offer owner's wallet to cancel it.
 * 403 without a proven wallet · 404 unknown offer, or not this wallet's · 409 when the offer is still
 * awaiting its own approval, is no longer open or no longer on the ledger, or a cancellation is
 * already waiting in Xaman.
 */
export async function requestOfferCancellation(
  deps: OfferDeps,
  input: { session: AuthSession; offerId: string },
): Promise<OfferCancelRequestResult> {
  const owner = requireProvenWallet(input.session);
  const found = await deps.db.nFTOffer.findUnique({ where: { id: input.offerId }, select: { ownerAddress: true } });
  if (!found || found.ownerAddress !== owner) throw errors.notFound("Offer not found");

  // Bring the offer up to date first: its creation may have validated, and an earlier cancellation
  // may have been declined or expired.
  await reconcileOfferCreation(deps, input.offerId);
  await reconcileOfferCancellation(deps, input.offerId);
  const offer = await deps.db.nFTOffer.findUniqueOrThrow({
    where: { id: input.offerId },
    include: { ticket: { include: { event: { select: { title: true } }, tier: { select: { name: true } } } } },
  });
  if (offer.state === "PENDING_SIGNATURE") {
    throw errors.conflict("This offer is still waiting for your approval in Xaman. Decline it there instead");
  }
  if (offer.state === "CANCELLED") throw errors.conflict("This offer has already been cancelled");
  if (offer.state !== "ACTIVE" || !offer.offerIndex) {
    throw errors.conflict("This offer is no longer open, so there's nothing to cancel");
  }
  const offerIndex = offer.offerIndex;

  // Already gone from the ledger (taken or cancelled outside the app): record that instead of asking to sign.
  const live = await deps.ledger().getOffers(offer.nftokenId);
  if (!live.sellOffers.some((o) => o.offerIndex === offerIndex)) {
    await syncOfferWithLedger(deps, offer);
    throw errors.conflict("This offer is no longer on the XRP Ledger, so there's nothing to cancel");
  }

  // One cancellation in flight per offer: hold it under a lock on the offer row.
  const hold = await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "NFTOffer" WHERE "id" = ${offer.id}::uuid FOR UPDATE`;
    const current = await tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id }, select: { state: true } });
    if (current.state !== "ACTIVE") throw errors.conflict("This offer is no longer open, so there's nothing to cancel");
    const inFlight = await tx.ledgerTransaction.count({
      where: { relatedOfferId: offer.id, type: "NFTokenCancelOffer", status: "PENDING", appliedAt: null },
    });
    if (inFlight > 0) {
      throw errors.conflict("A cancellation of this offer is already waiting for your approval in Xaman");
    }
    return tx.ledgerTransaction.create({
      data: {
        type: "NFTokenCancelOffer",
        network: deps.config.network as LedgerTransaction["network"],
        account: owner,
        status: "PENDING",
        relatedTicketId: offer.ticketId,
        relatedOfferId: offer.id,
      },
    });
  });

  const what = offer.ticket
    ? `${offer.ticket.event.title} — ${offer.ticket.tier.name} #${offer.ticket.serial}`
    : `NFT ${offer.nftokenId.slice(0, 8)}…`;
  const price = offer.kind === "GIFT" ? "" : ` at ${formatDropsAsXrp(offer.amountDrops)} XRP`;
  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "CANCEL_OFFER",
      txjson: {
        TransactionType: "NFTokenCancelOffer",
        Account: owner,
        NFTokenOffers: [offerIndex],
        Memos: [{ Memo: { MemoType: convertStringToHex(CANCEL_MEMO_TYPE), MemoData: convertStringToHex(offer.id) } }],
      },
      instruction: truncate(`Cancel ${KIND_LABELS[offer.kind]}: ${what}${price}`, MAX_INSTRUCTION_LENGTH),
      reference: offer.id,
    });
  } catch (error) {
    // No sign request exists: release the hold so the owner can try again.
    await deps.db.ledgerTransaction.update({ where: { id: hold.id }, data: { status: "DROPPED", appliedAt: new Date() } });
    throw error;
  }
  await deps.db.ledgerTransaction.update({ where: { id: hold.id }, data: { signRequestRef: request.id } });

  const { ticket: _ticket, ...row } = offer;
  return { offer: toNFTOfferDto(row), request };
}

/** Reconciles every cancellation of one offer that is still in flight. Safe to call repeatedly. */
export async function reconcileOfferCancellation(deps: CancelReconcileDeps, offerId: string): Promise<void> {
  const attempts = await deps.db.ledgerTransaction.findMany({
    where: { relatedOfferId: offerId, type: "NFTokenCancelOffer", appliedAt: null },
    orderBy: { createdAt: "asc" },
  });
  for (const attempt of attempts) await reconcileCancellation(deps, attempt);
}

async function reconcileCancellation(deps: CancelReconcileDeps, attempt: LedgerTransaction): Promise<void> {
  if (attempt.appliedAt || !attempt.relatedOfferId) return;
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
      return applyCancellation(deps, offer, attempt, request);
    default:
      return applyFailedCancellation(deps, offer, attempt, request);
  }
}

async function applyCancellation(
  deps: CancelReconcileDeps,
  offer: NFTOffer,
  attempt: LedgerTransaction,
  request: TransactionRequest,
): Promise<void> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenCancelOffer") {
    throw new Error(`Transaction ${confirmed.hash} is not an offer cancellation`);
  }
  if (confirmed.account !== offer.ownerAddress || confirmed.account !== attempt.account) {
    throw new Error(`Cancellation ${attempt.id} was signed by ${confirmed.account}, not ${offer.ownerAddress}`);
  }
  // The ledger has the last word: cancelled only if the offer is gone from it.
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const gone = !offer.offerIndex || !live.sellOffers.some((o) => o.offerIndex === offer.offerIndex);

  const now = new Date();
  await deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: attempt.id, appliedAt: null },
      data: {
        hash: confirmed.hash,
        account: confirmed.account,
        status: "VALIDATED_SUCCESS",
        resultCode: confirmed.result,
        ledgerIndex: confirmed.ledgerIndex,
        validatedAt: confirmed.closeTime ? new Date(confirmed.closeTime) : now,
        appliedAt: now,
      },
    });
    if (claimed.count === 0 || !gone) return;
    // A purchase recorded first wins: an ACCEPTED offer stays ACCEPTED.
    await tx.nFTOffer.updateMany({
      where: { id: offer.id, state: { in: ["ACTIVE", "STALE"] } },
      data: { state: "CANCELLED", cancelTxHash: confirmed.hash, lastSyncedAt: now },
    });
  });
}

async function applyFailedCancellation(
  deps: CancelReconcileDeps,
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
  // A rejected cancellation usually means the offer had already gone (e.g. just accepted): re-check.
  if (claimed.count > 0 && reachedLedger) {
    const current = await deps.db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
    await syncOfferWithLedger(deps, current, now);
  }
}
