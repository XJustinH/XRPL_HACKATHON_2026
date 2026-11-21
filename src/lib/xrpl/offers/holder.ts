import { convertStringToHex, isValidClassicAddress, NFTokenCreateOfferFlags } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type { TicketOfferRequestResult, TransactionPurpose, TransactionRequest } from "@/contracts/xrpl";
import { requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import { formatDropsAsXrp } from "../format";
import { OFFER_MEMO_TYPE, type OfferDeps } from "./primary";

/**
 * Offers made by a ticket's current holder (XRPL-036, 040, 041). The holder lists a ticket they own
 * with an `NFTokenCreateOffer` (sell) signed in their own Xaman wallet:
 *
 * | Kind      | Price           | Destination           | Who can accept                         |
 * |-----------|-----------------|-----------------------|----------------------------------------|
 * | `RESALE`  | holder's price  | none                  | anyone; listed in-app only when the resale rule allows (XRPL-037) |
 * | `PRIVATE` | holder's price  | the named recipient   | only that wallet, enforced by the ledger |
 * | `GIFT`    | 0               | the named recipient   | only that wallet, enforced by the ledger |
 *
 * - Only the wallet holding the NFT on a validated ledger can make an offer, and only for a ticket
 *   whose primary sale happened (primary inventory is listed with XRPL-029).
 * - A ticket that has been checked in, or whose event has finished, can't be offered.
 * - A ticket has at most one live offer (awaiting approval or active) at a time.
 * - The offer becomes ACTIVE only from the validated transaction, through the same recording as
 *   primary offers (`reconcileOfferCreation`).
 * - A gift or private sale can't be undone once the recipient accepts. On the ledger the NFT simply
 *   moves; the app records the new owner from the validated transaction.
 */

export type HolderOfferKind = "RESALE" | "PRIVATE" | "GIFT";

export type HolderOfferInput =
  | { kind: "RESALE"; amountDrops: string }
  | { kind: "PRIVATE"; amountDrops: string; destination: string }
  | { kind: "GIFT"; destination: string };

/** Optional in-app resale price cap (XRPL-095), checked before the holder signs anything. */
export type ResalePriceCheck = (
  faceValueDrops: string,
  amountDrops: string,
) => { allowed: true } | { allowed: false; message: string };

export interface HolderOfferDeps extends OfferDeps {
  resalePrice?: ResalePriceCheck;
}

const PURPOSES: Record<HolderOfferKind, TransactionPurpose> = {
  RESALE: "CREATE_RESALE_OFFER",
  PRIVATE: "CREATE_PRIVATE_OFFER",
  GIFT: "CREATE_GIFT_OFFER",
};

const LIVE_STATES = ["PENDING_SIGNATURE", "ACTIVE"] as const;
const MAX_INSTRUCTION_LENGTH = 280;

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Asks the holder's wallet to sign a resale listing, private sale or gift for one ticket.
 * 403 without a proven wallet · 404 unknown ticket or unpublished event · 409 when the ticket is not
 * minted, not yet sold on primary, checked in, the event has finished, it is already offered, the
 * wallet does not hold it, the recipient is the holder, or the resale price is above the cap.
 */
export async function requestHolderOffer(
  deps: HolderOfferDeps,
  input: { session: AuthSession; ticketId: string; offer: HolderOfferInput },
): Promise<TicketOfferRequestResult> {
  const holder = requireProvenWallet(input.session);
  const spec = input.offer;
  const amountDrops = spec.kind === "GIFT" ? "0" : spec.amountDrops;
  const destination = spec.kind === "RESALE" ? null : spec.destination;
  if (destination !== null && !isValidClassicAddress(destination)) {
    throw errors.validation(undefined, "The recipient isn't a valid XRPL address");
  }
  if (destination === holder) throw errors.conflict("You can't send a ticket to your own wallet");

  const ticket = await deps.db.ticketNFT.findUnique({
    where: { id: input.ticketId },
    include: {
      tier: { select: { name: true, priceDrops: true } },
      event: { select: { title: true, status: true, startsAt: true, endsAt: true } },
    },
  });
  if (!ticket || ticket.event.status !== "PUBLISHED") throw errors.notFound("Ticket not found");
  if (ticket.mintStatus !== "MINTED" || !ticket.nftokenId) throw errors.conflict("This ticket has not been minted yet");
  if (!ticket.primarySoldAt) {
    throw errors.conflict("This ticket hasn't been sold yet. The organiser lists unsold tickets from the event page");
  }
  if (new Date(ticket.event.endsAt ?? ticket.event.startsAt).getTime() <= Date.now()) {
    throw errors.conflict("This event has finished, so its tickets can't be offered");
  }
  if ((await deps.db.checkInRecord.count({ where: { ticketId: ticket.id } })) > 0) {
    throw errors.conflict("This ticket has already been used to enter the event");
  }
  if (spec.kind === "RESALE" && deps.resalePrice) {
    const check = deps.resalePrice(ticket.tier.priceDrops, amountDrops);
    if (!check.allowed) throw errors.conflict(check.message);
  }

  // Only the wallet that holds the NFT right now may offer it (validated ledger).
  const nftokenId = ticket.nftokenId;
  const holding = await deps.ledger().verifyOwner(nftokenId, holder);
  if (!holding.owns) {
    throw errors.conflict("Your connected wallet doesn't hold this ticket, so it can't offer it");
  }

  const offer = await deps.db.$transaction(async (tx) => {
    // One live offer per ticket: concurrent requests wait here, then see the first.
    await tx.$queryRaw`SELECT "id" FROM "TicketNFT" WHERE "id" = ${ticket.id}::uuid FOR UPDATE`;
    const live = await tx.nFTOffer.findFirst({
      where: { ticketId: ticket.id, state: { in: [...LIVE_STATES] }, ownerAddress: holder },
      select: { state: true },
    });
    if (live) {
      throw errors.conflict(
        live.state === "ACTIVE"
          ? "This ticket already has an open offer. Cancel it before making another"
          : "An offer for this ticket is already waiting for approval in Xaman",
      );
    }
    return tx.nFTOffer.create({
      data: {
        ticketId: ticket.id,
        nftokenId,
        kind: spec.kind,
        state: "PENDING_SIGNATURE",
        ownerAddress: holder,
        destinationAddress: destination,
        amountDrops,
        createdByUserId: input.session.userId,
      },
    });
  });

  const what = `${ticket.event.title} — ${ticket.tier.name} #${ticket.serial}`;
  const instruction =
    spec.kind === "RESALE"
      ? `Sell ticket: ${what} for ${formatDropsAsXrp(amountDrops)} XRP`
      : spec.kind === "PRIVATE"
        ? `Sell ticket to ${shortAddress(destination as string)}: ${what} for ${formatDropsAsXrp(amountDrops)} XRP`
        : `Give ticket to ${shortAddress(destination as string)}: ${what}. Once they accept, this can't be undone.`;

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: PURPOSES[spec.kind],
      txjson: {
        TransactionType: "NFTokenCreateOffer",
        Account: holder,
        NFTokenID: nftokenId,
        Amount: amountDrops,
        Flags: NFTokenCreateOfferFlags.tfSellNFToken,
        ...(destination ? { Destination: destination } : {}),
        Memos: [
          { Memo: { MemoType: convertStringToHex(OFFER_MEMO_TYPE), MemoData: convertStringToHex(offer.id) } },
        ],
      },
      instruction: truncate(instruction, MAX_INSTRUCTION_LENGTH),
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
      account: holder,
      status: "PENDING",
      signRequestRef: request.id,
      relatedTicketId: ticket.id,
      relatedOfferId: offer.id,
    },
  });

  return { offer: toNFTOfferDto(offer), request };
}
