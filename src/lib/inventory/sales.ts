import type { PrismaClient } from "@/generated/prisma/client";
import type { ConfirmedLedgerTx, LedgerReconcileResult } from "@/contracts";
import { errors } from "@/lib/http/response";

/**
 * Recording confirmed primary sales (XRPL-032). Owner: Agent A.
 *
 * `reconcileLedgerTransaction(hash)` applies one validated XRPL transaction to the app's records.
 * Today it handles primary sales: an `NFTokenAcceptOffer` that consumed one of this app's PRIMARY
 * sell offers, whether the buyer used the app's purchase flow (Agent B, XRPL-031) or accepted the
 * offer from another wallet app. It:
 *  - marks the offer ACCEPTED with the accept tx hash and the buyer from the validated transaction,
 *  - marks the ticket sold (`primarySoldAt`, `primarySaleTxHash`) and caches its owner,
 *  - records the transaction in `LedgerTransaction` with `appliedAt`.
 * Effects apply once. A repeat or concurrent call for the same hash, or after the in-app flow
 * already applied it, changes nothing (ALREADY_APPLIED). Remaining inventory and the sold-out state
 * are derived from `primarySoldAt` (primary-inventory.ts), so they update with no extra step.
 */

type Db = Pick<PrismaClient, "nFTOffer" | "$transaction">;

/** The parts of Agent B's read service this needs (structural, so tests can fake it). */
export type SalesLedger = {
  getValidatedTx(
    hash: string,
  ): Promise<
    Pick<ConfirmedLedgerTx, "hash" | "result" | "ledgerIndex" | "closeTime" | "transactionType" | "account" | "nftokenId" | "offerIndex">
  >;
  verifyOwner(
    nftokenId: string,
    address: string,
  ): Promise<{ owns: boolean; provenance: { ledgerIndex: number | null; validated: boolean } }>;
};

export type SalesDeps = { db: Db; ledger: () => SalesLedger; now?: () => Date };

const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export async function reconcileLedgerTransaction(deps: SalesDeps, hash: string): Promise<LedgerReconcileResult> {
  // Throws if the transaction isn't validated with tesSUCCESS: nothing is recorded from a guess.
  const tx = await deps.ledger().getValidatedTx(hash);
  if (tx.transactionType !== "NFTokenAcceptOffer" || !tx.offerIndex) {
    return { outcome: "NOT_APPLICABLE", reason: "NOT_AN_ACCEPT" };
  }

  const offer = await deps.db.nFTOffer.findUnique({ where: { offerIndex: tx.offerIndex } });
  if (!offer) return { outcome: "NOT_APPLICABLE", reason: "UNKNOWN_OFFER" };
  if (offer.kind !== "PRIMARY") return { outcome: "NOT_APPLICABLE", reason: "NOT_PRIMARY" };
  if (tx.nftokenId && tx.nftokenId !== offer.nftokenId) {
    throw errors.conflict("That transaction transferred a different NFT than this offer was for");
  }

  const txHash = tx.hash;
  const buyer = tx.account;
  const already: LedgerReconcileResult = {
    outcome: "ALREADY_APPLIED",
    kind: "PRIMARY_SALE",
    offerId: offer.id,
    ticketId: offer.ticketId,
  };
  const holding = await deps.ledger().verifyOwner(offer.nftokenId, buyer);
  const now = deps.now?.() ?? new Date();
  const soldAt = tx.closeTime ? new Date(tx.closeTime) : now;
  const validated = {
    account: buyer,
    status: "VALIDATED_SUCCESS" as const,
    resultCode: tx.result,
    ledgerIndex: tx.ledgerIndex,
    validatedAt: soldAt,
    appliedAt: now,
  };

  try {
    return await deps.db.$transaction(async (db) => {
      // A ticket already marked sold may predate this hash being recorded on it: fill it in.
      const backfillSaleHash = () =>
        offer.ticketId
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
        // The buyer's in-app purchase attempt (Agent B) may not know its hash yet: use that row,
        // so the in-app flow later sees the sale as already applied instead of recording it twice.
        const attempt = await db.ledgerTransaction.findFirst({
          where: { relatedOfferId: offer.id, type: "NFTokenAcceptOffer", account: buyer, hash: null, appliedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (attempt) {
          const claimed = await db.ledgerTransaction.updateMany({
            where: { id: attempt.id, hash: null, appliedAt: null },
            data: { hash: txHash, ...validated },
          });
          if (claimed.count === 0) return already;
        } else {
          // A sale made outside the app's purchase flow. A concurrent duplicate fails on the unique hash.
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

      // 2. Apply the sale.
      await db.nFTOffer.updateMany({
        where: { id: offer.id, state: { not: "ACCEPTED" } },
        data: { state: "ACCEPTED", acceptTxHash: txHash, acceptedByAddress: buyer, lastSyncedAt: now },
      });
      if (offer.ticketId) {
        const sold = await db.ticketNFT.updateMany({
          where: { id: offer.ticketId, primarySoldAt: null },
          data: {
            primarySoldAt: soldAt,
            primarySaleTxHash: txHash,
            cachedOwnerAddress: holding.owns ? buyer : null,
            ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
            ownerSyncedAt: now,
            ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
          },
        });
        if (sold.count === 0) await backfillSaleHash();
      }
      return {
        outcome: "APPLIED",
        kind: "PRIMARY_SALE",
        offerId: offer.id,
        ticketId: offer.ticketId,
        buyerAddress: buyer,
      } satisfies LedgerReconcileResult;
    });
  } catch (err) {
    // A concurrent call recorded the same hash first (unique LedgerTransaction.hash).
    if (isUniqueViolation(err)) return already;
    throw err;
  }
}
