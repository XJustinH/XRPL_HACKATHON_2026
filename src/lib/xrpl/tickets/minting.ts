import { convertStringToHex, parseNFTokenID } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import type { EventMints, MintRequestResult, MintTicketView, TransactionRequest } from "@/contracts/xrpl";
import type { LedgerTransaction, PrismaClient, TicketNFT } from "@/generated/prisma/client";
import { requireEventOwner, requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { toTicketDto, toTicketTierDto } from "@/lib/db/mappers";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { explorerNftUrl, explorerTxUrl } from "../explorer";
import type { XrplQueryService } from "../query";
import type { WalletTransactionRequests } from "../wallet/transaction-requests";
import { encodeNftUri, ticketTaxon, TICKET_NFT_FLAGS } from "./metadata";
import { createPendingTicket } from "./store";
import { isPubliclyReachable } from "./urls";

/**
 * Minting ticket NFTs (XRPL-024). The seller's own wallet signs an NFTokenMint through
 * Xaman; the ticket becomes MINTED only from the validated transaction, and that happens
 * exactly once (LedgerTransaction.appliedAt).
 */

export interface MintDeps {
  db: PrismaClient;
  /** Lazy, so listing works even when Xaman is not configured. */
  transactions: () => Pick<WalletTransactionRequests, "create" | "get">;
  ledger: () => Pick<XrplQueryService, "getValidatedTx" | "verifyOwner">;
  config: Pick<XrplConfig, "network" | "explorerUrl">;
  /** Public base URL for metadata URIs (`ticketPublicBaseUrl()`). */
  baseUrl: string;
}

/** Memo on every mint linking the NFT to its ticket record, for later reconciliation (XRPL-026). */
const TICKET_MEMO_TYPE = convertStringToHex("xrpl-ticketing/ticket");
const MAX_INSTRUCTION_LENGTH = 280;
const MAX_RECONCILE_PER_REQUEST = 20;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function toMintTicketView(ticket: TicketNFT, config: Pick<XrplConfig, "explorerUrl">): MintTicketView {
  return {
    ...toTicketDto(ticket),
    nftExplorerUrl: ticket.nftokenId ? explorerNftUrl(config, ticket.nftokenId) : null,
    mintTxExplorerUrl: ticket.mintTxHash ? explorerTxUrl(config, ticket.mintTxHash) : null,
  };
}

/**
 * The event, if `session` is its owner (Agent A's `requireEventOwner`, XRPL-013):
 * 404 if it does not exist, 403 NOT_EVENT_OWNER otherwise.
 */
async function loadOwnedEvent(db: PrismaClient, session: AuthSession, eventId: string) {
  await requireEventOwner(db, session, eventId);
  return db.event.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true } });
}

/**
 * Reserves the next ticket of a tier and asks the seller's wallet to sign its mint.
 * Only the event's owner may mint, and only with the wallet this session has proven
 * (XRPL-012): that wallet is the issuer, never an address sent by the browser.
 * The NFT is transferable, uses the event's taxon, points at the ticket's metadata URI,
 * and carries a memo with the ticket ID.
 */
export async function requestTicketMint(
  deps: MintDeps,
  input: { session: AuthSession; eventId: string; tierId: string },
): Promise<MintRequestResult> {
  const event = await loadOwnedEvent(deps.db, input.session, input.eventId);
  const issuerAddress = requireProvenWallet(input.session); // 403 WALLET_NOT_VERIFIED

  const ticket = await createPendingTicket(deps.db, {
    eventId: event.id,
    tierId: input.tierId,
    issuerAddress,
    baseUrl: deps.baseUrl,
  });
  const metadataUri = ticket.metadataUri as string;
  const tier = await deps.db.ticketTier.findUniqueOrThrow({
    where: { id: ticket.tierId },
    select: { name: true },
  });

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "MINT_TICKET",
      txjson: {
        TransactionType: "NFTokenMint",
        Account: issuerAddress,
        NFTokenTaxon: ticketTaxon(event.id),
        Flags: TICKET_NFT_FLAGS,
        URI: encodeNftUri(metadataUri),
        Memos: [{ Memo: { MemoType: TICKET_MEMO_TYPE, MemoData: convertStringToHex(ticket.id) } }],
      },
      instruction: truncate(
        `Mint ticket NFT: ${event.title} — ${tier.name} #${ticket.serial}`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: ticket.id,
    });
  } catch (error) {
    // No sign request exists, so release the reservation for the next attempt.
    await deps.db.ticketNFT.update({ where: { id: ticket.id }, data: { mintStatus: "FAILED" } });
    throw error;
  }

  await deps.db.ledgerTransaction.create({
    data: {
      type: "NFTokenMint",
      network: deps.config.network as XrplNetwork,
      account: issuerAddress,
      status: "PENDING",
      signRequestRef: request.id,
      relatedTicketId: ticket.id,
    },
  });

  return {
    ticket: toMintTicketView(ticket, deps.config),
    request,
    metadataPublic: isPubliclyReachable(metadataUri),
  };
}

/**
 * Brings one ticket's mint up to date with its sign request and the ledger. Safe to call
 * repeatedly and concurrently: effects are applied once.
 */
export async function reconcileTicketMint(deps: MintDeps, ticketId: string): Promise<TicketNFT> {
  const ticket = await deps.db.ticketNFT.findUnique({ where: { id: ticketId } });
  if (!ticket) throw errors.notFound("Ticket not found");
  if (ticket.mintStatus === "MINTED" || ticket.mintStatus === "FAILED") return ticket;

  const pending = await deps.db.ledgerTransaction.findFirst({
    where: { relatedTicketId: ticketId, type: "NFTokenMint", appliedAt: null, signRequestRef: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending?.signRequestRef) return ticket;

  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(pending.signRequestRef);
  } catch {
    return ticket; // Wallet service unreachable: try again on the next read.
  }

  switch (request.status) {
    case "PENDING":
    case "OPENED":
      return ticket;
    case "SUBMITTED":
      if (request.txHash) {
        await deps.db.ledgerTransaction.updateMany({
          where: { id: pending.id, hash: null, appliedAt: null },
          data: { hash: request.txHash },
        });
      }
      // Only from PENDING: a concurrent reconcile may already have recorded the outcome.
      await deps.db.ticketNFT.updateMany({
        where: { id: ticketId, mintStatus: "PENDING" },
        data: { mintStatus: "SUBMITTED" },
      });
      return deps.db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    case "CONFIRMED":
      return applyConfirmedMint(deps, ticket, pending, request);
    default:
      return applyFailedMint(deps, ticket, pending, request);
  }
}

async function applyConfirmedMint(
  deps: MintDeps,
  ticket: TicketNFT,
  pending: LedgerTransaction,
  request: TransactionRequest,
): Promise<TicketNFT> {
  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenMint" || !confirmed.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} is not a mint with an NFTokenID`);
  }
  const issuer = confirmed.account;
  const parsed = parseNFTokenID(confirmed.nftokenId);
  if (parsed.Issuer !== issuer || parsed.Taxon !== ticketTaxon(ticket.eventId)) {
    throw new Error(`NFT ${confirmed.nftokenId} does not match ticket ${ticket.id}`);
  }
  const holding = await deps.ledger().verifyOwner(confirmed.nftokenId, issuer);
  if (holding.owns && holding.nft?.uri !== ticket.metadataUri) {
    throw new Error(`NFT ${confirmed.nftokenId} does not point at ticket ${ticket.id}'s metadata`);
  }

  const now = new Date();
  const mintedAt = confirmed.closeTime ? new Date(confirmed.closeTime) : now;
  return deps.db.$transaction(async (tx) => {
    const claimed = await tx.ledgerTransaction.updateMany({
      where: { id: pending.id, appliedAt: null },
      data: {
        hash: confirmed.hash,
        account: issuer,
        status: "VALIDATED_SUCCESS",
        resultCode: confirmed.result,
        ledgerIndex: confirmed.ledgerIndex,
        validatedAt: mintedAt,
        appliedAt: now,
      },
    });
    if (claimed.count === 0) return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });

    await tx.ticketTier.update({ where: { id: ticket.tierId }, data: { mintedQuantity: { increment: 1 } } });
    return tx.ticketNFT.update({
      where: { id: ticket.id },
      data: {
        mintStatus: "MINTED",
        nftokenId: confirmed.nftokenId,
        mintTxHash: confirmed.hash,
        mintedAt,
        issuerAddress: issuer,
        cachedOwnerAddress: holding.owns ? issuer : null,
        ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
        ownerSyncedAt: now,
        ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
      },
    });
  });
}

async function applyFailedMint(
  deps: MintDeps,
  ticket: TicketNFT,
  pending: LedgerTransaction,
  request: TransactionRequest,
): Promise<TicketNFT> {
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
    // Already applied by a concurrent reconcile; the ticket may even be reserved again.
    if (claimed.count === 0) return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
    await tx.ticketNFT.updateMany({
      where: { id: ticket.id, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
      data: { mintStatus: "FAILED" },
    });
    return tx.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
  });
}

/** Every tier of a seller's event with its tickets, after reconciling mints in flight. */
export async function getEventMints(
  deps: MintDeps,
  input: { session: AuthSession; eventId: string },
): Promise<EventMints> {
  const event = await loadOwnedEvent(deps.db, input.session, input.eventId);

  const inFlight = await deps.db.ticketNFT.findMany({
    where: { eventId: event.id, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_RECONCILE_PER_REQUEST,
  });
  for (const { id } of inFlight) {
    try {
      await reconcileTicketMint(deps, id);
    } catch (error) {
      console.error(`[mint] could not reconcile ticket ${id}`, error);
    }
  }

  const tiers = await deps.db.ticketTier.findMany({
    where: { eventId: event.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { tickets: { orderBy: { serial: "asc" } } },
  });
  return {
    eventId: event.id,
    title: event.title,
    tiers: tiers.map(({ tickets, ...tier }) => ({
      ...toTicketTierDto(tier),
      tickets: tickets.map((ticket) => toMintTicketView(ticket, deps.config)),
    })),
  };
}
