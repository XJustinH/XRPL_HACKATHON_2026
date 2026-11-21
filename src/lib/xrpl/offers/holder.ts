import { convertStringToHex, isValidClassicAddress, NFTokenCreateOfferFlags } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type { TicketOfferRequestResult, TransactionPurpose, TransactionRequest } from "@/contracts/xrpl";
import { requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toNFTOfferDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";
import { syncOfferWithLedger } from "./ledger-check";
import { OFFER_MEMO_TYPE, reconcileOfferCreation, UNSIGNABLE_AFTER_MS, type OfferDeps } from "./primary";

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
  /** Balance and reserve reads too, for the reserve a new offer needs. */
  ledger: () => Pick<
    XrplQueryService,
    "getValidatedTx" | "verifyOwner" | "getOffers" | "getAccountInfo" | "getReserves"
  >;
  resalePrice?: ResalePriceCheck;
}

/** Room for the network fee on top of the reserve a new offer locks (a fee is ~12 drops). */
const FEE_ALLOWANCE_DROPS = BigInt(1000);
/** Offers settled per step (this ticket's before a new offer, the wallet's others before the reserve check). */
const MAX_SETTLED_FOR_RESERVE = 10;

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
  // Settle earlier offers first: a declined, expired or vanished one no longer holds the ticket.
  await settleEarlierOffers(deps, ticket.id);
  await requireOfferReserve(deps, { ownerAddress: holder, ticketId: ticket.id });

  const offer = await deps.db.$transaction(async (tx) => {
    // One live offer per ticket: concurrent requests wait here, then see the first.
    await tx.$queryRaw`SELECT "id" FROM "TicketNFT" WHERE "id" = ${ticket.id}::uuid FOR UPDATE`;
    // A check-in recorded since the check above (its insert waits on this lock) still counts.
    if ((await tx.checkInRecord.count({ where: { ticketId: ticket.id } })) > 0) {
      throw errors.conflict("This ticket has already been used to enter the event");
    }
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
    // Offers by earlier holders can't be filled now that the NFT has moved on.
    await tx.nFTOffer.updateMany({
      where: { ticketId: ticket.id, state: "ACTIVE", ownerAddress: { not: holder } },
      data: { state: "STALE", lastSyncedAt: new Date() },
    });
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

/**
 * Brings the ticket's live offers up to date before a new one is made: offers awaiting approval are
 * reconciled (a declined or expired one becomes FAILED), and ACTIVE ones are checked against the
 * ledger (one taken, cancelled or left behind outside the app is closed). Best effort: an offer that
 * can't be checked right now is left as it is, and still counts under the lock.
 */
async function settleEarlierOffers(deps: HolderOfferDeps, ticketId: string): Promise<void> {
  const live = await deps.db.nFTOffer.findMany({
    where: { ticketId, state: { in: [...LIVE_STATES] } },
    orderBy: { createdAt: "asc" },
    take: MAX_SETTLED_FOR_RESERVE,
  });
  for (const offer of live) {
    try {
      if (offer.state === "PENDING_SIGNATURE") await reconcileOfferCreation(deps, offer.id);
      else await syncOfferWithLedger(deps, offer);
    } catch (error) {
      console.error(`[offers] could not settle offer ${offer.id} before a new one`, error);
    }
  }
}

/**
 * An offer is a ledger object, so the holder's account must keep one more owner-reserve increment
 * (0.2 XRP on Testnet) for it, plus the fee. Without it the ledger would reject the offer with
 * tecINSUFFICIENT_RESERVE and still charge the fee. The wallet's other offers still awaiting approval
 * will each need one too, once settled: a declined or expired one needs none, and a validated one is
 * already in the account's OwnerCount. 409 when the wallet can't cover it.
 */
async function requireOfferReserve(
  deps: HolderOfferDeps,
  owner: { ownerAddress: string; ticketId: string },
): Promise<void> {
  const awaitingApproval = {
    ownerAddress: owner.ownerAddress,
    state: "PENDING_SIGNATURE" as const,
    // This ticket's own offers fall to the one-live-offer rule instead.
    ticketId: { not: owner.ticketId },
    // Older requests can't be signed any more, and any that were are already in OwnerCount.
    createdAt: { gt: new Date(Date.now() - UNSIGNABLE_AFTER_MS) },
  };
  const others = await deps.db.nFTOffer.findMany({
    where: awaitingApproval,
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_SETTLED_FOR_RESERVE,
  });
  for (const { id } of others) {
    try {
      await reconcileOfferCreation(deps, id);
    } catch (error) {
      console.error(`[offers] could not reconcile offer ${id} before the reserve check`, error);
    }
  }

  const ledger = deps.ledger();
  const [account, reserves, awaiting] = await Promise.all([
    ledger.getAccountInfo(owner.ownerAddress),
    ledger.getReserves(),
    deps.db.nFTOffer.count({ where: awaitingApproval }),
  ]);
  // The holder's account holds the NFT, so it exists; if the ledger says otherwise, let it decide.
  if (!account.exists || account.balanceDrops === null) return;
  const increment = BigInt(reserves.incrementDrops);
  const locked = BigInt(reserves.baseDrops) + increment * BigInt(account.ownerCount ?? 0);
  const balance = BigInt(account.balanceDrops);
  const spendable = balance > locked ? balance - locked : BigInt(0);
  const required = increment * BigInt(awaiting + 1) + FEE_ALLOWANCE_DROPS;
  if (spendable < required) {
    const others =
      awaiting > 0
        ? ` Your ${awaiting} other offer${awaiting === 1 ? "" : "s"} waiting for approval in Xaman will need it too.`
        : "";
    throw errors.conflict(
      `Not enough XRP to make this offer: each offer holds ${formatDropsAsXrp(increment)} XRP of your wallet's reserve until it is accepted or cancelled, and this wallet has ${formatDropsAsXrp(spendable)} XRP spare.${others}`,
      { requiredDrops: required.toString(), spendableDrops: spendable.toString() },
    );
  }
}
