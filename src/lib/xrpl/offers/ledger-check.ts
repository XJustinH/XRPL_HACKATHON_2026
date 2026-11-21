import type { NFTOffer, PrismaClient } from "@/generated/prisma/client";

import type { XrplQueryService } from "../query";

/**
 * Checks of an app offer against the ledger, shared by buying (XRPL-031/039), cancelling and the
 * cleanup of offers that closed outside the app (XRPL-042). The ledger is authoritative for offers.
 */

export type LedgerCheckDeps = {
  db: Pick<PrismaClient, "nFTOffer" | "ledgerTransaction">;
  ledger: () => Pick<XrplQueryService, "getOffers" | "verifyOwner">;
};

/** Is the offer still live on the ledger and backed by the seller still holding the NFT? */
export async function isLiveOnLedger(deps: Pick<LedgerCheckDeps, "ledger">, offer: NFTOffer): Promise<boolean> {
  if (!offer.offerIndex) return false;
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const onLedger = live.sellOffers.find((o) => o.offerIndex === offer.offerIndex);
  if (
    !onLedger ||
    onLedger.owner !== offer.ownerAddress ||
    onLedger.amountDrops !== offer.amountDrops ||
    // Same Destination as recorded: none for primary and resale, the recipient for private sales and gifts.
    (onLedger.destination ?? null) !== (offer.destinationAddress ?? null)
  ) {
    return false;
  }
  return (await deps.ledger().verifyOwner(offer.nftokenId, offer.ownerAddress)).owns;
}

/**
 * Stale-offer cleanup (XRPL-042): closes an ACTIVE offer the ledger no longer backs, so it leaves every
 * active view. An offer past its expiry becomes EXPIRED. One that is gone or no longer matches (taken
 * or cancelled outside the app, or the seller no longer holds the NFT) becomes STALE.
 *
 * Left alone while a purchase or cancellation of it is in flight: those record their own outcome
 * from the validated transaction. Returns the offer's state afterwards.
 */
export async function syncOfferWithLedger(
  deps: LedgerCheckDeps,
  offer: NFTOffer,
  now = new Date(),
): Promise<NFTOffer["state"]> {
  if (offer.state !== "ACTIVE") return offer.state;
  const inFlight = await deps.db.ledgerTransaction.count({
    where: {
      relatedOfferId: offer.id,
      type: { in: ["NFTokenAcceptOffer", "NFTokenCancelOffer"] },
      status: "PENDING",
      appliedAt: null,
    },
  });
  if (inFlight > 0) return offer.state;

  const next = offer.expiresAt && offer.expiresAt <= now ? "EXPIRED" : (await isLiveOnLedger(deps, offer)) ? null : "STALE";
  if (!next) {
    await deps.db.nFTOffer.updateMany({ where: { id: offer.id, state: "ACTIVE" }, data: { lastSyncedAt: now } });
    return "ACTIVE";
  }
  const updated = await deps.db.nFTOffer.updateMany({
    where: { id: offer.id, state: "ACTIVE" },
    data: { state: next, lastSyncedAt: now },
  });
  // Someone else recorded an outcome first: report what's there now.
  if (updated.count === 0) {
    return (await deps.db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id }, select: { state: true } })).state;
  }
  return next;
}
