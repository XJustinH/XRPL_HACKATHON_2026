import { convertStringToHex, NFTokenCreateOfferFlags } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type { PrimaryOfferListing, PrimaryOfferRequestResult, TransactionRequest } from "@/contracts/xrpl";
import type { LedgerTransaction, NFTOffer, PrismaClient } from "@/generated/prisma/client";
import { requireEventOwner, requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { isXrplServiceError } from "../errors";
import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";
import {
  TRANSACTION_REQUEST_EXPIRY_MINUTES,
  type WalletTransactionRequests,
} from "../wallet/transaction-requests";

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
/**
 * Xaman stops showing a wallet request 10 minutes after it was made, though one already open in the
 * app can still be answered. Past this age, an offer awaiting approval
 * whose request the app never recorded (e.g. a crash) or Xaman no longer knows is settled from the
 * ledger instead of holding its ticket forever.
 */
export const UNSIGNABLE_AFTER_MS = (TRANSACTION_REQUEST_EXPIRY_MINUTES + 5) * 60 * 1000;
const unsignable = (since: Date) => Date.now() - since.getTime() > UNSIGNABLE_AFTER_MS;

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
    // A ticket used at the door can't be sold. A check-in's insert waits on this lock, so it counts.
    if ((await tx.checkInRecord.count({ where: { ticketId: ticket.id } })) > 0) {
      throw errors.conflict("This ticket has already been used to enter the event");
    }
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
 * Brings one offer's creation up to date with its sign request and the ledger. Works for every
 * kind the app creates (primary, resale, private sale, gift). Safe to call repeatedly and
 * concurrently: effects are applied once, and a late answer never moves an offer back.
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
  if (!pending?.signRequestRef) {
    // No request recorded (the server stopped between the two writes): nothing can be signed now.
    const recorded = await deps.db.ledgerTransaction.count({
      where: { relatedOfferId: offer.id, type: "NFTokenCreateOffer" },
    });
    return recorded === 0 && unsignable(offer.createdAt) ? releaseUnsignedOffer(deps, offer, null) : offer;
  }

  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(pending.signRequestRef);
  } catch (error) {
    // Xaman no longer knows a request that expired long ago. If it was signed, the transaction it
    // was signed into decides; otherwise nothing can be signed any more.
    if (isXrplServiceError(error) && error.code === "NOT_FOUND" && unsignable(pending.createdAt)) {
      return pending.hash
        ? settleFromTransaction(deps, offer, pending, pending.hash)
        : releaseUnsignedOffer(deps, offer, pending);
    }
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
      return applyCreatedOffer(deps, offer, pending, request.txHash as string);
    default:
      return applyFailedOffer(deps, offer, pending, request);
  }
}

/**
 * Settles an offer awaiting approval whose request can't be signed any more and can't be followed
 * (never recorded, or forgotten by Xaman), so it doesn't hold its ticket forever. If a matching sell
 * offer is on the ledger anyway, the request was signed: the offer is left for a person to look at
 * rather than freed for a second listing.
 */
async function releaseUnsignedOffer(
  deps: OfferDeps,
  offer: NFTOffer,
  pending: LedgerTransaction | null,
): Promise<NFTOffer> {
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const signed = live.sellOffers.some(
    (o) =>
      o.owner === offer.ownerAddress &&
      o.amountDrops === offer.amountDrops &&
      (o.destination ?? null) === (offer.destinationAddress ?? null),
  );
  if (signed) {
    console.warn(`[offers] offer ${offer.id} lost its sign request but a matching offer is on the ledger`);
    return offer;
  }
  const now = new Date();
  return deps.db.$transaction(async (tx) => {
    if (pending) {
      const claimed = await tx.ledgerTransaction.updateMany({
        where: { id: pending.id, appliedAt: null },
        data: { status: "DROPPED", appliedAt: now },
      });
      if (claimed.count === 0) return tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
    }
    await tx.nFTOffer.updateMany({
      where: { id: offer.id, state: "PENDING_SIGNATURE" },
      data: { state: "FAILED", lastSyncedAt: now },
    });
    return tx.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
  });
}

/**
 * Settles an offer from the transaction its request was signed into, when the request itself can't
 * be read any more: validated with tesSUCCESS gives ACTIVE (or STALE), validated with a failure gives
 * FAILED, and never validated, long after it could have been, is released like an unsigned request.
 * Anything else (the ledger can't be read) is thrown, to be retried on a later read.
 */
async function settleFromTransaction(
  deps: OfferDeps,
  offer: NFTOffer,
  pending: LedgerTransaction,
  txHash: string,
): Promise<NFTOffer> {
  try {
    return await applyCreatedOffer(deps, offer, pending, txHash);
  } catch (error) {
    if (isXrplServiceError(error) && error.code === "TX_FAILED") {
      return applyFailedOffer(deps, offer, pending, {
        txHash,
        failureReason: "LEDGER_REJECTED",
        engineResult: error.rippledError ?? null,
        ledgerIndex: null,
      });
    }
    if (isXrplServiceError(error) && error.code === "NOT_VALIDATED") {
      return releaseUnsignedOffer(deps, offer, pending);
    }
    throw error;
  }
}

async function applyCreatedOffer(
  deps: OfferDeps,
  offer: NFTOffer,
  pending: LedgerTransaction,
  txHash: string,
): Promise<NFTOffer> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(txHash);
  if (confirmed.transactionType !== "NFTokenCreateOffer" || !confirmed.offerIndex) {
    throw new Error(`Transaction ${confirmed.hash} did not create an NFT offer`);
  }
  if (confirmed.account !== offer.ownerAddress) {
    throw new Error(`Offer ${offer.id} was signed by ${confirmed.account}, not ${offer.ownerAddress}`);
  }
  // The live offer must be the one the app asked for: this NFT, a sell offer, the price, and the same
  // Destination (none for primary and resale offers; the named recipient for private sales and gifts).
  const live = await deps.ledger().getOffers(offer.nftokenId);
  const onLedger = live.sellOffers.find((o) => o.offerIndex === confirmed.offerIndex) ?? null;
  if (
    onLedger &&
    (onLedger.owner !== offer.ownerAddress ||
      onLedger.amountDrops !== offer.amountDrops ||
      (onLedger.destination ?? null) !== (offer.destinationAddress ?? null))
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
        // Gone already (accepted or cancelled outside the app): created on the ledger, but not live.
        // An offer that is live stays ACTIVE even if its ticket was checked in meanwhile, so it can be
        // cancelled. Buying and listing refuse used tickets themselves.
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
  request: Pick<TransactionRequest, "txHash" | "failureReason" | "engineResult" | "ledgerIndex">,
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
 *
 * An offer another buyer is in the middle of buying is marked `purchasePending` and listed after the
 * free ones at its price (XRPL-035), so the next buyer is given a ticket they can actually buy.
 * `viewerAddress` is the reader's own wallet: their own purchase in flight doesn't count.
 */
export async function listPrimaryOffers(
  db: Pick<PrismaClient, "nFTOffer" | "ledgerTransaction">,
  eventId: string,
  options: { now?: Date; viewerAddress?: string | null } = {},
): Promise<PrimaryOfferListing[]> {
  const now = options.now ?? new Date();
  const offers = await db.nFTOffer.findMany({
    where: {
      kind: "PRIMARY",
      state: "ACTIVE",
      offerIndex: { not: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      // A ticket already used to enter the event isn't for sale, whatever its offer says.
      ticket: { eventId, mintStatus: "MINTED", primarySoldAt: null, checkIns: { none: {} } },
    },
    include: { ticket: { select: { id: true, serial: true, tier: { select: { id: true, name: true } } } } },
  });
  // Purchases in flight. An older one can't be signed any more, and the next attempt to buy its
  // ticket settles it, so it doesn't keep the ticket out of reach.
  const inFlight =
    offers.length === 0
      ? []
      : await db.ledgerTransaction.findMany({
          where: {
            relatedOfferId: { in: offers.map((offer) => offer.id) },
            type: "NFTokenAcceptOffer",
            status: "PENDING",
            appliedAt: null,
            createdAt: { gt: new Date(now.getTime() - UNSIGNABLE_AFTER_MS) },
          },
          select: { relatedOfferId: true, account: true },
        });
  const viewer = options.viewerAddress ?? null;
  const held = new Set(
    inFlight.filter((t) => viewer === null || t.account !== viewer).map((t) => t.relatedOfferId),
  );
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
      purchasePending: held.has(offer.id),
    }))
    .sort((a, b) => {
      const diff = BigInt(a.amountDrops) - BigInt(b.amountDrops);
      if (diff !== BigInt(0)) return diff < BigInt(0) ? -1 : 1;
      if (a.purchasePending !== b.purchasePending) return a.purchasePending ? 1 : -1;
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
  return listPrimaryOffers(deps.db, input.eventId, { viewerAddress: input.session?.walletAddress });
}

/** Same as `reconcilePrimaryOffer`, named for offers of any kind (XRPL-036/040/041). */
export const reconcileOfferCreation = reconcilePrimaryOffer;
