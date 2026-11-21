import type { ReconciledOffer, TicketReconcileResult } from "@/contracts";
import type { NFTOffer } from "@/generated/prisma/client";
import { errors } from "@/lib/http/response";
import { reconcileOfferCancellation } from "@/lib/xrpl/offers/cancel";
import { syncOfferWithLedger } from "@/lib/xrpl/offers/ledger-check";
import { reconcileOfferCreation, type OfferDeps } from "@/lib/xrpl/offers/primary";
import { reconcileOfferPurchases } from "@/lib/xrpl/offers/purchase";
import { resolveTicketOwnership, type OwnershipDeps } from "@/lib/xrpl/tickets/ownership";

/**
 * Bringing one ticket in step with the XRP Ledger (XRPL-043). Owner: Agent A.
 *
 * `reconcileTicket` is the refresh path for a ticket whose NFT may have moved, through the app or
 * outside it (`POST /api/tickets/:id/reconcile`):
 *  1. Each live offer for the ticket (awaiting approval or active) is brought up to date with Agent B's
 *     offer services: its creation, then purchases and a cancellation in flight, then the ledger
 *     itself (the stale-offer check from XRPL-042). An offer the ledger no longer backs closes. That
 *     includes an offer whose owner has since transferred the ticket away: it can't be bought any
 *     more, so it leaves every listing.
 *  2. The ticket's owner is read from a validated ledger, and the app's cache is refreshed (Agent B's
 *     `resolveTicketOwnership`, XRPL-028).
 * Every step is idempotent and records only what the validated ledger proves. Production wiring is
 * `mintingDeps()` from `@/lib/xrpl/tickets/server`.
 */

export type TicketSyncDeps = Omit<OfferDeps, "ledger" | "config"> & {
  ledger: () => ReturnType<OfferDeps["ledger"]> & ReturnType<OwnershipDeps["ledger"]>;
  config: OfferDeps["config"] & OwnershipDeps["config"];
};

const LIVE_STATES: NFTOffer["state"][] = ["PENDING_SIGNATURE", "ACTIVE"];

export async function reconcileTicket(
  deps: TicketSyncDeps,
  input: { ticketId: string; viewerAddress?: string | null },
): Promise<TicketReconcileResult> {
  const ticket = await deps.db.ticketNFT.findUnique({ where: { id: input.ticketId }, select: { id: true } });
  if (!ticket) throw errors.notFound("Ticket not found");

  const live = await deps.db.nFTOffer.findMany({
    where: { ticketId: ticket.id, state: { in: LIVE_STATES } },
    orderBy: { createdAt: "asc" },
  });
  const offers: ReconciledOffer[] = [];
  for (const offer of live) {
    if (offer.state === "PENDING_SIGNATURE") await reconcileOfferCreation(deps, offer.id);
    // A purchase or cancellation that already reached the ledger is recorded as such, before the
    // offer is judged against the ledger.
    await reconcileOfferPurchases(deps, offer.id);
    await reconcileOfferCancellation(deps, offer.id);
    const current = await deps.db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
    offers.push({
      offerId: offer.id,
      kind: offer.kind,
      ownerAddress: offer.ownerAddress,
      previousState: offer.state,
      state: await syncOfferWithLedger(deps, current),
    });
  }

  const ownership = await resolveTicketOwnership(deps, input);
  return { ownership, offers };
}
