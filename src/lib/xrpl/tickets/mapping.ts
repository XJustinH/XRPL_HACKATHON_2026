import { AppId } from "@/contracts/common";
import type { XrplNetwork } from "@/contracts/entities";
import type { LedgerMint, MintMappingIssue, MintMappingProblem, MintMappingReport } from "@/contracts/xrpl";
import type { TicketNFT } from "@/generated/prisma/client";
import { requireEventOwner } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";

import { XrplServiceError } from "../errors";
import { ticketTaxon, TICKET_MEMO_TYPE } from "./metadata";
import type { MintDeps } from "./minting";

/**
 * NFT-to-ticket mapping reconciliation (XRPL-026). The ledger is the source of truth:
 *
 * - **Rebuild.** Every ticket mint carries a memo with its ticket ID. Reading the issuers'
 *   validated mint history finds mints the app never recorded (for example when the wallet
 *   service lost a request's outcome) and records them, exactly once.
 * - **Verify.** Every MINTED ticket is checked against its validated mint transaction.
 *
 * Disagreements are reported, never "fixed" by overwriting a mapping. The database rejects a
 * second ticket for the same NFTokenID (`TicketNFT.nftokenId` is unique).
 */

export type MappingDeps = Pick<MintDeps, "db" | "ledger" | "config">;

/** Pages of 400 transactions read per issuer and run: the most recent 4,000. */
const MAX_HISTORY_PAGES = 10;
const HISTORY_PAGE_SIZE = 400;

type Outcome =
  | { kind: "other-event" }
  | { kind: "matched" }
  | { kind: "recorded" }
  | { kind: "issue"; issue: MintMappingIssue };

class LostRace extends Error {}

/** The ticket ID a mint's memo names, if it is one of the app's ticket mints. */
export function ticketIdFromMint(mint: LedgerMint): string | null {
  const memo = mint.memos.find((m) => m.type === TICKET_MEMO_TYPE);
  return memo?.data && AppId.safeParse(memo.data).success ? memo.data : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Rebuilds and verifies the NFT mapping of every ticket of an event. Only the event's owner
 * may run it (Agent A's `requireEventOwner`). Safe to repeat: a second run records nothing new.
 */
export async function reconcileEventMappings(
  deps: MappingDeps,
  input: { session: AuthSession; eventId: string; maxPages?: number },
): Promise<MintMappingReport> {
  const { eventId } = input;
  await requireEventOwner(deps.db, input.session, eventId);
  const taxon = ticketTaxon(eventId);

  const issuerRows = await deps.db.ticketNFT.findMany({
    where: { eventId, issuerAddress: { not: null } },
    select: { issuerAddress: true },
    distinct: ["issuerAddress"],
  });
  const issuers = issuerRows.map((row) => row.issuerAddress as string).sort();

  const recorded: string[] = [];
  const issues: MintMappingIssue[] = [];
  const seen = new Map<string, LedgerMint>(); // mint tx hash -> validated mint for this event
  let complete = true;

  for (const issuer of issuers) {
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= (input.maxPages ?? MAX_HISTORY_PAGES)) {
        complete = false;
        break;
      }
      const batch = await deps.ledger().getAccountMints(issuer, { cursor, limit: HISTORY_PAGE_SIZE });
      for (const mint of batch.items) {
        const ticketId = ticketIdFromMint(mint);
        if (!mint.succeeded || !mint.nftokenId || !ticketId) continue;
        const outcome = await applyLedgerMint(deps, { eventId, taxon, ticketId, mint });
        if (outcome.kind === "other-event") continue;
        seen.set(mint.hash, mint);
        if (outcome.kind === "recorded") recorded.push(ticketId);
        if (outcome.kind === "issue") issues.push(outcome.issue);
      }
      if (!batch.nextCursor) break;
      cursor = batch.nextCursor;
    }
  }

  const minted = await deps.db.ticketNFT.findMany({
    where: { eventId, mintStatus: "MINTED" },
    orderBy: [{ tierId: "asc" }, { serial: "asc" }],
  });
  let verified = 0;
  for (const ticket of minted) {
    const issue = await verifyMintedTicket(deps, ticket, seen.get(ticket.mintTxHash ?? ""));
    if (issue) issues.push(issue);
    else verified += 1;
  }

  return {
    eventId,
    issuers,
    mintsFound: seen.size,
    recorded,
    verified,
    issues,
    complete,
    checkedAt: new Date().toISOString(),
  };
}

function issueFor(
  problem: MintMappingProblem,
  detail: string,
  ticket: Pick<TicketNFT, "id" | "serial"> | null,
  mint: Pick<LedgerMint, "nftokenId" | "hash"> | null,
): MintMappingIssue {
  return {
    problem,
    ticketId: ticket?.id ?? null,
    serial: ticket?.serial ?? null,
    nftokenId: mint?.nftokenId ?? null,
    txHash: mint?.hash ?? null,
    detail,
  };
}

/** Compares one validated ticket mint from the ledger with the app's records. */
async function applyLedgerMint(
  deps: MappingDeps,
  args: { eventId: string; taxon: number; ticketId: string; mint: LedgerMint },
): Promise<Outcome> {
  const { eventId, taxon, ticketId, mint } = args;
  const ticket = await deps.db.ticketNFT.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    if (mint.taxon !== taxon) return { kind: "other-event" };
    return {
      kind: "issue",
      issue: issueFor(
        "TICKET_NOT_FOUND",
        `Mint ${mint.hash} names ticket ${ticketId}, which this app has no record of`,
        null,
        mint,
      ),
    };
  }
  if (ticket.eventId !== eventId) return { kind: "other-event" };
  if (ticket.nftokenId === mint.nftokenId) return { kind: "matched" };
  if (ticket.nftokenId) {
    return {
      kind: "issue",
      issue: issueFor(
        "TICKET_HAS_OTHER_NFT",
        `Ticket #${ticket.serial} is mapped to NFT ${ticket.nftokenId}, but mint ${mint.hash} created ${mint.nftokenId} for it too`,
        ticket,
        mint,
      ),
    };
  }
  if (mint.taxon !== taxon) {
    return {
      kind: "issue",
      issue: issueFor(
        "TAXON_MISMATCH",
        `Mint ${mint.hash} used taxon ${mint.taxon}, not this event's ${taxon}`,
        ticket,
        mint,
      ),
    };
  }
  if (mint.uri !== ticket.metadataUri) {
    return {
      kind: "issue",
      issue: issueFor(
        "URI_MISMATCH",
        `Mint ${mint.hash} points at ${mint.uri ?? "no URI"}, not the ticket's metadata`,
        ticket,
        mint,
      ),
    };
  }
  return recordLedgerMint(deps, ticket, mint);
}

/** Records a validated mint the app missed: ticket MINTED, ledger record applied, tier count +1. */
async function recordLedgerMint(deps: MappingDeps, ticket: TicketNFT, mint: LedgerMint): Promise<Outcome> {
  const nftokenId = mint.nftokenId as string;
  const holding = await deps.ledger().verifyOwner(nftokenId, mint.issuer);
  const now = new Date();
  const mintedAt = mint.closeTime ? new Date(mint.closeTime) : now;
  try {
    await deps.db.$transaction(async (tx) => {
      const applied = {
        hash: mint.hash,
        account: mint.account,
        status: "VALIDATED_SUCCESS" as const,
        resultCode: mint.engineResult,
        ledgerIndex: mint.ledgerIndex,
        validatedAt: mintedAt,
        appliedAt: now,
        relatedTicketId: ticket.id,
      };
      const known = await tx.ledgerTransaction.findUnique({ where: { hash: mint.hash } });
      const pending =
        known ??
        (await tx.ledgerTransaction.findFirst({
          where: { relatedTicketId: ticket.id, type: "NFTokenMint", appliedAt: null, hash: null },
          orderBy: { createdAt: "desc" },
        }));
      if (pending) {
        const claimed = await tx.ledgerTransaction.updateMany({
          where: { id: pending.id, appliedAt: null },
          data: applied,
        });
        if (claimed.count === 0) throw new LostRace();
      } else {
        await tx.ledgerTransaction.create({
          data: { type: "NFTokenMint", network: deps.config.network as XrplNetwork, ...applied },
        });
      }
      const updated = await tx.ticketNFT.updateMany({
        where: { id: ticket.id, nftokenId: null },
        data: {
          mintStatus: "MINTED",
          nftokenId,
          mintTxHash: mint.hash,
          mintedAt,
          issuerAddress: mint.issuer,
          cachedOwnerAddress: holding.owns ? mint.issuer : null,
          ownerSyncStatus: holding.owns ? "SYNCED" : "STALE",
          ownerSyncedAt: now,
          ownerSyncLedgerIndex: holding.provenance.ledgerIndex,
        },
      });
      if (updated.count === 0) throw new LostRace();
      await tx.ticketTier.update({
        where: { id: ticket.tierId },
        data: { mintedQuantity: { increment: 1 } },
      });
    });
    return { kind: "recorded" };
  } catch (error) {
    if (error instanceof LostRace) {
      // Someone recorded this ticket or transaction in the meantime: compare again.
      const current = await deps.db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
      if (current.nftokenId === nftokenId) return { kind: "matched" };
      return {
        kind: "issue",
        issue: issueFor(
          current.nftokenId ? "TICKET_HAS_OTHER_NFT" : "MINT_TX_MISMATCH",
          current.nftokenId
            ? `Ticket #${ticket.serial} is mapped to NFT ${current.nftokenId}, but mint ${mint.hash} created ${nftokenId} for it too`
            : `Mint ${mint.hash} is already recorded with a different outcome`,
          ticket,
          mint,
        ),
      };
    }
    if (isUniqueViolation(error)) {
      const holder = await deps.db.ticketNFT.findFirst({
        where: { nftokenId },
        select: { id: true, serial: true },
      });
      if (holder && holder.id !== ticket.id) {
        return {
          kind: "issue",
          issue: issueFor(
            "NFT_MAPPED_TO_OTHER_TICKET",
            `NFT ${nftokenId} is already mapped to ticket ${holder.id}; the database refused to map it twice`,
            ticket,
            mint,
          ),
        };
      }
    }
    throw error;
  }
}

/** Checks a MINTED ticket against its validated mint transaction. Null when they agree. */
async function verifyMintedTicket(
  deps: MappingDeps,
  ticket: TicketNFT,
  fromHistory: LedgerMint | undefined,
): Promise<MintMappingIssue | null> {
  const recordedMint = { nftokenId: ticket.nftokenId, hash: ticket.mintTxHash ?? "" };
  const mismatch = (detail: string) =>
    issueFor("MINT_TX_MISMATCH", detail, ticket, { ...recordedMint, hash: ticket.mintTxHash ?? "" });

  if (fromHistory) {
    if (fromHistory.nftokenId === ticket.nftokenId && fromHistory.issuer === ticket.issuerAddress)
      return null;
    return mismatch(
      `Mint ${fromHistory.hash} created ${fromHistory.nftokenId} for ${fromHistory.issuer}, but ticket #${ticket.serial} records ${ticket.nftokenId} for ${ticket.issuerAddress}`,
    );
  }
  if (!ticket.mintTxHash) return mismatch(`Ticket #${ticket.serial} is MINTED without a mint transaction`);

  try {
    const confirmed = await deps.ledger().getValidatedTx(ticket.mintTxHash);
    if (
      confirmed.transactionType === "NFTokenMint" &&
      confirmed.nftokenId === ticket.nftokenId &&
      confirmed.account === ticket.issuerAddress
    ) {
      return null;
    }
    return mismatch(
      `Transaction ${confirmed.hash} is a ${confirmed.transactionType} by ${confirmed.account} for ${confirmed.nftokenId ?? "no NFT"}, not ticket #${ticket.serial}'s mint`,
    );
  } catch (error) {
    if (error instanceof XrplServiceError && (error.code === "NOT_VALIDATED" || error.code === "TX_FAILED")) {
      return issueFor(
        "MINT_TX_NOT_VALIDATED",
        `The ledger could not confirm mint ${ticket.mintTxHash} for ticket #${ticket.serial}: ${error.message}`,
        ticket,
        recordedMint,
      );
    }
    throw error;
  }
}
