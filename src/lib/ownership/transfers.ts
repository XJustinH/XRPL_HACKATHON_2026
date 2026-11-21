import type { PrismaClient } from "@/generated/prisma/client";
import type { ConfirmedLedgerTx, LedgerReconcileResult, OfferKind, TransferKind } from "@/contracts";
import { errors } from "@/lib/http/response";

/**
 * Recording accepted offers from their validated transactions (XRPL-032, XRPL-043). Owner: Agent A.
 *
 * `reconcileLedgerTransaction(hash)` applies one validated `NFTokenAcceptOffer` that took one of the
 * app's sell offers (the transaction's `NFTokenSellOffer`): a primary sale, a resale, a private sale or
 * a gift. It works whether the new holder used the app (Agent B's purchase flow, XRPL-031/039) or
 * accepted the offer from another wallet app. It:
 *  - marks the offer ACCEPTED, with the accept tx hash and the accepting account,
 *  - for a primary sale, marks the ticket sold (`primarySoldAt`, `primarySaleTxHash`),
 *  - caches the ticket's new owner once the ledger confirms the accepting account holds it, unless the
 *    cache already holds an owner read from a later ledger (a hash reported after the ticket moved on),
 *  - records the transaction in `LedgerTransaction` with `appliedAt`.
 * The accepting account is the new holder, except in a brokered sale, where it is the broker: the
 * ticket's owner is then left unknown (`STALE`) rather than guessed.
 *
 * Effects apply once. A repeat or concurrent call for the same hash, or one after the in-app flow
 * already applied it, changes nothing (ALREADY_APPLIED). Remaining inventory and the sold-out state
 * are derived from `primarySoldAt` (src/lib/inventory), so they update with no extra step.
 */

type Db = Pick<PrismaClient, "nFTOffer" | "$transaction">;

/** The parts of Agent B's read service this needs (structural, so tests can fake it). */
export type LedgerTxReader = {
  getValidatedTx(
    hash: string,
  ): Promise<
    Pick<
      ConfirmedLedgerTx,
      "hash" | "result" | "ledgerIndex" | "closeTime" | "transactionType" | "account" | "nftokenId" | "acceptedSellOfferIndex"
    >
  >;
  verifyOwner(
    nftokenId: string,
    address: string,
  ): Promise<{ owns: boolean; provenance: { ledgerIndex: number | null; validated: boolean } }>;
};

export type LedgerTxDeps = { db: Db; ledger: () => LedgerTxReader; now?: () => Date };

const TRANSFER_KINDS: Record<OfferKind, TransferKind> = {
  PRIMARY: "PRIMARY_SALE",
  RESALE: "RESALE",
  PRIVATE: "PRIVATE_SALE",
  GIFT: "GIFT",
};

const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export async function reconcileLedgerTransaction(deps: LedgerTxDeps, hash: string): Promise<LedgerReconcileResult> {
  // Throws if the transaction isn't validated with tesSUCCESS: nothing is recorded from a guess.
  const tx = await deps.ledger().getValidatedTx(hash);
  if (tx.transactionType !== "NFTokenAcceptOffer") return { outcome: "NOT_APPLICABLE", reason: "NOT_AN_ACCEPT" };

  // The app only makes sell offers, so an accept that took none (an owner taking a buy offer) isn't one.
  const offer = tx.acceptedSellOfferIndex
    ? await deps.db.nFTOffer.findUnique({ where: { offerIndex: tx.acceptedSellOfferIndex } })
    : null;
  if (!offer) return { outcome: "NOT_APPLICABLE", reason: "UNKNOWN_OFFER" };
  if (tx.nftokenId && tx.nftokenId !== offer.nftokenId) {
    throw errors.conflict("That transaction transferred a different NFT than this offer was for");
  }
  // Only the named recipient can take a private sale or gift (the ledger enforces it).
  if (offer.destinationAddress && tx.account !== offer.destinationAddress) {
    throw errors.conflict("That transaction wasn't made by the offer's recipient");
  }

  const kind = TRANSFER_KINDS[offer.kind];
  const txHash = tx.hash;
  const acceptedBy = tx.account;
  const already: LedgerReconcileResult = { outcome: "ALREADY_APPLIED", kind, offerId: offer.id, ticketId: offer.ticketId };
  const holding = await deps.ledger().verifyOwner(offer.nftokenId, acceptedBy);
  const now = deps.now?.() ?? new Date();
  const at = tx.closeTime ? new Date(tx.closeTime) : now;
  const validated = {
    account: acceptedBy,
    status: "VALIDATED_SUCCESS" as const,
    resultCode: tx.result,
    ledgerIndex: tx.ledgerIndex,
    validatedAt: at,
    appliedAt: now,
  };

  try {
    return await deps.db.$transaction(async (db) => {
      // A ticket already marked sold may predate its sale hash being recorded on it: fill it in.
      const backfillSaleHash = () =>
        offer.kind === "PRIMARY" && offer.ticketId
          ? db.ticketNFT.updateMany({
              where: { id: offer.ticketId, primarySoldAt: { not: null }, primarySaleTxHash: null },
              data: { primarySaleTxHash: txHash },
            })
          : null;

      // 1. Claim the transaction exactly once.
      const known = await db.ledgerTransaction.findUnique({ where: { hash: txHash } });
      if (known) {
        const claimed = known.appliedAt
          ? 0
          : (await db.ledgerTransaction.updateMany({ where: { id: known.id, appliedAt: null }, data: validated })).count;
        if (claimed === 0) {
          await backfillSaleHash();
          return already;
        }
      } else {
        // The in-app purchase attempt (Agent B) may not know its hash yet: use that row, so the
        // in-app flow later sees the transfer as already applied instead of recording it twice.
        const attempt = await db.ledgerTransaction.findFirst({
          where: { relatedOfferId: offer.id, type: "NFTokenAcceptOffer", account: acceptedBy, hash: null, appliedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (attempt) {
          const claimed = await db.ledgerTransaction.updateMany({
            where: { id: attempt.id, hash: null, appliedAt: null },
            data: { hash: txHash, ...validated },
          });
          if (claimed.count === 0) return already;
        } else {
          // Accepted outside the app's purchase flow. A concurrent duplicate fails on the unique hash.
          await db.ledgerTransaction.create({
            data: {
              hash: txHash,
              type: "NFTokenAcceptOffer",
              relatedOfferId: offer.id,
              relatedTicketId: offer.ticketId,
              ...validated,
            },
          });
        }
      }

      // 2. Apply it.
      await db.nFTOffer.updateMany({
        where: { id: offer.id, state: { not: "ACCEPTED" } },
        data: { state: "ACCEPTED", acceptTxHash: txHash, acceptedByAddress: acceptedBy, lastSyncedAt: now },
      });
      if (offer.ticketId) {
        if (offer.kind === "PRIMARY") {
          const sold = await db.ticketNFT.updateMany({
            where: { id: offer.ticketId, primarySoldAt: null },
            data: { primarySoldAt: at, primarySaleTxHash: txHash },
          });
          if (sold.count === 0) await backfillSaleHash();
        }
        // A resale, private sale or gift only moves the ticket: its primary sale stays as it was.
        await db.ticketNFT.updateMany({
          where: {
            id: offer.ticketId,
            OR: [{ ownerSyncLedgerIndex: null }, { ownerSyncLedgerIndex: { lte: tx.ledgerIndex } }],
          },
          data: {
            cachedOwnerAddress: holding.owns ? acceptedBy : null,
            ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
            ownerSyncedAt: now,
            ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
          },
        });
      }
      return {
        outcome: "APPLIED",
        kind,
        offerId: offer.id,
        ticketId: offer.ticketId,
        acceptedByAddress: acceptedBy,
      } satisfies LedgerReconcileResult;
    });
  } catch (err) {
    // A concurrent call recorded the same hash first (unique LedgerTransaction.hash).
    if (isUniqueViolation(err)) return already;
    throw err;
  }
}
