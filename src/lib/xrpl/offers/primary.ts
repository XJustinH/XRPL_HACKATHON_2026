import { convertStringToHex, NFTokenCreateOfferFlags } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type { PrimaryOfferListing, PrimaryOfferRequestResult, TransactionRequest } from "@/contracts/xrpl";
import type { LedgerTransaction, NFTOffer, PrismaClient } from "@/generated/prisma/client";
import { requireEventOwner, requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";
import type { WalletTransactionRequests } from "../wallet/transaction-requests";

/**
 * Primary sale offers (XRPL-029). The event's owner lists a minted ticket for sale at its
 * tier price with an `NFTokenCreateOffer` (sell) signed in their own Xaman wallet. The offer
 * becomes ACTIVE only from the validated transaction, with the ledger's offer index.
 *
 * - Only a ticket the seller's proven wallet holds on a validated ledger can be listed.
 * - A ticket has at most one live primary offer (PENDING_SIGNATURE or ACTIVE).
 * - Offers are public on the ledger: anyone can accept one. Purchases are XRPL-031.
 */

export interface OfferDeps {
  db: PrismaClient;
  transactions: () => Pick<WalletTransactionRequests, "create" | "get">;
  ledger: () => Pick<XrplQueryService, "getValidatedTx" | "verifyOwner" | "getOffers">;
  config: Pick<XrplConfig, "network" | "explorerUrl">;
}

/** Memo on every offer the app creates; the data is the app's offer ID. */
export const OFFER_MEMO_TYPE = "xrpl-ticketing/offer";
const MAX_INSTRUCTION_LENGTH = 280;
const MAX_RECONCILE_PER_REQUEST = 20;
const LIVE_STATES = ["PENDING_SIGNATURE", "ACTIVE"] as const;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Asks the seller's wallet to list a minted ticket for sale at its tier price.
 * 404 unknown ticket · 403 not the event's owner / no proven wallet · 409 when the ticket is
 * not minted, already sold, already listed, has no price, or the wallet does not hold it.
 */
export async function requestPrimaryOffer(
  deps: OfferDeps,
  input: { session: AuthSession; ticketId: string },
): Promise<PrimaryOfferRequestResult> {
  const ticket = await deps.db.ticketNFT.findUnique({
    where: { id: input.ticketId },
    include: {
      tier: { select: { name: true, priceDrops: true } },
      event: { select: { title: true } },
    },
  });
  if (!ticket) throw errors.notFound("Ticket not found");
  await requireEventOwner(deps.db, input.session, ticket.eventId);
  const seller = requireProvenWallet(input.session);

  if (ticket.mintStatus !== "MINTED" || !ticket.nftokenId) {
    throw errors.conflict("This ticket has not been minted yet");
  }
  if (ticket.primarySoldAt) throw errors.conflict("This ticket has already been sold");
  const priceDrops = ticket.tier.priceDrops;
  if (BigInt(priceDrops) <= BigInt(0)) {
    throw errors.conflict("Give this tier a price above 0 XRP before listing its tickets");
  }

  // Only NFTs the seller's wallet holds right now are listed (validated ledger).
  const holding = await deps.ledger().verifyOwner(ticket.nftokenId, seller);
  if (!holding.owns) {
    throw errors.conflict("Your connected wallet does not hold this ticket's NFT, so it cannot list it");
  }

  const nftokenId = ticket.nftokenId;
  const offer = await deps.db.$transaction(async (tx) => {
    // One live primary offer per ticket: concurrent requests wait here, then see the first.
    await tx.$queryRaw`SELECT "id" FROM "TicketNFT" WHERE "id" = ${ticket.id}::uuid FOR UPDATE`;
    const live = await tx.nFTOffer.findFirst({
      where: { ticketId: ticket.id, kind: "PRIMARY", state: { in: [...LIVE_STATES] } },
      select: { state: true },
    });
    if (live) {
      throw errors.conflict(
        live.state === "ACTIVE" ? "This ticket is already for sale" : "This ticket is already being listed",
      );
    }
    return tx.nFTOffer.create({
      data: {
        ticketId: ticket.id,
        nftokenId,
        kind: "PRIMARY",
        state: "PENDING_SIGNATURE",
        ownerAddress: seller,
        amountDrops: priceDrops,
        createdByUserId: input.session.userId,
      },
    });
  });

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "CREATE_PRIMARY_OFFER",
      txjson: {
        TransactionType: "NFTokenCreateOffer",
        Account: seller,
        NFTokenID: nftokenId,
        Amount: priceDrops,
        Flags: NFTokenCreateOfferFlags.tfSellNFToken,
        Memos: [
          { Memo: { MemoType: convertStringToHex(OFFER_MEMO_TYPE), MemoData: convertStringToHex(offer.id) } },
        ],
      },
      instruction: truncate(
        `Sell ticket: ${ticket.event.title} — ${ticket.tier.name} #${ticket.serial} for ${formatDropsAsXrp(priceDrops)} XRP`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: offer.id,
    });
  } catch (error) {
    // No sign request exists, so free the ticket for another attempt.
    await deps.db.nFTOffer.update({ where: { id: offer.id }, data: { state: "FAILED" } });
    throw error;
  }

  await deps.db.ledgerTransaction.create({
    data: {
      type: "NFTokenCreateOffer",
      network: deps.config.network as XrplNetwork,
      account: seller,
      status: "PENDING",
      signRequestRef: request.id,
      relatedTicketId: ticket.id,
      relatedOfferId: offer.id,
    },
  });

  return { offer: toNFTOfferDto(offer), request };
}

/**
 * Brings one primary offer up to date with its sign request and the ledger. Safe to call
 * repeatedly and concurrently: effects are applied once, and a late answer never moves an
 * offer back.
 */
export async function reconcilePrimaryOffer(deps: OfferDeps, offerId: string): Promise<NFTOffer> {
  const offer = await deps.db.nFTOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw errors.notFound("Offer not found");
  if (offer.state !== "PENDING_SIGNATURE") return offer;

  const pending = await deps.db.ledgerTransaction.findFirst({
    where: {
      relatedOfferId: offerId,
      type: "NFTokenCreateOffer",
      appliedAt: null,
      signRequestRef: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!pending?.signRequestRef) return offer;

  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(pending.signRequestRef);
  } catch {
    return offer; // Wallet service unreachable: try again on the next read.
  }

  switch (request.status) {
    case "PENDING":
    case "OPENED":
      return offer;
    case "SUBMITTED":
      if (request.txHash) {
        await deps.db.ledgerTransaction.updateMany({
          where: { id: pending.id, hash: null, appliedAt: null },
          data: { hash: request.txHash },
        });
      }
      return offer;
    case "CONFIRMED":
      return applyCreatedOffer(deps, offer, pending, request);
    default:
      return applyFailedOffer(deps, offer, pending, request);
  }
}

async function applyCreatedOffer(
  deps: OfferDeps,
  offer: NFTOffer,
  pending: LedgerTransaction,
  request: TransactionRequest,
): Promise<NFTOffer> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenCreateOffer" || !confirmed.offerIndex) {
    throw new Error(`Transaction ${confirmed.hash} did not create an NFT offer`);
  }
  if (confirmed.account !== offer.ownerAddress) {
    throw new Error(`Offer ${offer.id} was signed by ${confirmed.account}, not ${offer.ownerAddress}`);
  }
  // The live offer must be the one the app asked for: this NFT, a sell offer, the price, no Destination.
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const onLedger = live.sellOffers.find((o) => o.offerIndex === confirmed.offerIndex) ?? null;
  if (
    onLedger &&
    (onLedger.owner !== offer.ownerAddress ||
      onLedger.amountDrops !== offer.amountDrops ||
      onLedger.destination)
  ) {
    throw new Error(`Offer ${confirmed.offerIndex} on the ledger does not match offer ${offer.id}`);
  }

  const now = new Date();
  const validatedAt = confirmed.closeTime ? new Date(confirmed.closeTime) : now;
  return deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: pending.id, appliedAt: null },
      data: {
        hash: confirmed.hash,
        account: confirmed.account,
        status: "VALIDATED_SUCCESS",
        resultCode: confirmed.result,
        ledgerIndex: confirmed.ledgerIndex,
        validatedAt,
        appliedAt: now,
      },
    });
    if (claimed.count === 0) return tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
    await tx.nFTOffer.updateMany({
      where: { id: offer.id, state: "PENDING_SIGNATURE" },
      data: {
        // Gone already (accepted or cancelled outside the app): created, but no longer live.
        state: onLedger ? "ACTIVE" : "STALE",
        offerIndex: confirmed.offerIndex,
        createTxHash: confirmed.hash,
        lastSyncedAt: now,
      },
    });
    return tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
  });
}

async function applyFailedOffer(
  deps: OfferDeps,
  offer: NFTOffer,
  pending: LedgerTransaction,
  request: TransactionRequest,
): Promise<NFTOffer> {
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
    if (claimed.count > 0) {
      await tx.nFTOffer.updateMany({
        where: { id: offer.id, state: "PENDING_SIGNATURE" },
        data: { state: "FAILED", lastSyncedAt: now },
      });
    }
    return tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
  });
}

/** Reconciles an event's primary offers awaiting approval (bounded per call). */
export async function reconcileEventPrimaryOffers(deps: OfferDeps, eventId: string): Promise<void> {
  const inFlight = await deps.db.nFTOffer.findMany({
    where: { kind: "PRIMARY", state: "PENDING_SIGNATURE", ticket: { eventId } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_RECONCILE_PER_REQUEST,
  });
  for (const { id } of inFlight) {
    try {
      await reconcilePrimaryOffer(deps, id);
    } catch (error) {
      console.error(`[offers] could not reconcile primary offer ${id}`, error);
    }
  }
}

/**
 * Live primary offers for an event, cheapest first: ACTIVE, not expired, on unsold minted
 * tickets. Satisfies Agent C's `OfferPort.listPrimaryOffers` (each item has its fields).
 * A listed offer can still have been taken on the ledger since; buyers re-check it (XRPL-031/035).
 */
export async function listPrimaryOffers(
  db: Pick<PrismaClient, "nFTOffer">,
  eventId: string,
  now = new Date(),
): Promise<PrimaryOfferListing[]> {
  const offers = await db.nFTOffer.findMany({
    where: {
      kind: "PRIMARY",
      state: "ACTIVE",
      offerIndex: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ticket: { eventId, mintStatus: "MINTED", primarySoldAt: null },
    },
    include: { ticket: { select: { id: true, serial: true, tier: { select: { id: true, name: true } } } } },
  });
  return offers
    .filter((offer) => offer.ticket !== null)
    .map((offer) => ({
      offerId: offer.id,
      offerIndex: offer.offerIndex as string,
      nftokenId: offer.nftokenId,
      sellerAddress: offer.ownerAddress,
      amountDrops: offer.amountDrops,
      tierId: offer.ticket!.tier.id,
      tierName: offer.ticket!.tier.name,
      ticketId: offer.ticket!.id,
      serial: offer.ticket!.serial,
      expiresAt: offer.expiresAt ? offer.expiresAt.toISOString() : null,
    }))
    .sort((a, b) => {
      const diff = BigInt(a.amountDrops) - BigInt(b.amountDrops);
      if (diff !== BigInt(0)) return diff < BigInt(0) ? -1 : 1;
      return a.serial - b.serial;
    });
}

/**
 * Public listing for an event's page. Drafts are visible to their owner only (404 otherwise,
 * as for the event itself). The owner's own reads first reconcile offers awaiting approval.
 */
export async function getEventPrimaryOffers(
  deps: OfferDeps,
  input: { session: AuthSession | null; eventId: string },
): Promise<PrimaryOfferListing[]> {
  const event = await deps.db.event.findUnique({
    where: { id: input.eventId },
    select: { status: true, sellerId: true },
  });
  const isOwner = !!input.session && event?.sellerId === input.session.userId;
  if (!event || (event.status !== "PUBLISHED" && !isOwner)) throw errors.notFound("Event not found");
  if (isOwner) await reconcileEventPrimaryOffers(deps, input.eventId);
  return listPrimaryOffers(deps.db, input.eventId);
}
