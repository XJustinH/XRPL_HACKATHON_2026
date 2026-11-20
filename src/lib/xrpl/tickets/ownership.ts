import type { LedgerProof, TicketView } from "@/contracts/events";
import type { TicketOwnership } from "@/contracts/xrpl";
import type { PrismaClient } from "@/generated/prisma/client";
import { errors } from "@/lib/http/response";

import type { XrplConfig } from "../config";
import { isXrplServiceError } from "../errors";
import { explorerNftUrl, explorerTxUrl } from "../explorer";
import type { XrplQueryService } from "../query";

/**
 * Ticket ownership from the XRP Ledger (XRPL-028). The ledger is the source of truth; the
 * ticket's cached owner (`TicketNFT.cachedOwnerAddress`) is a display mirror that every check
 * refreshes. An owner is reported only when it was read from a validated ledger: anything
 * else is PENDING and must never be treated as owned.
 *
 * Owner lookup: Clio `nft_info` (getOwner) first. Without Clio, or before Clio has indexed a
 * new NFT, the wallets the app knows (cached owner, buyers, issuer) are checked on rippled.
 *
 * Also implements Agent C's `LedgerReadPort` reads for My tickets (XRPL-033) and the ticket
 * view (XRPL-034): `listTicketsForOwner`, `getTicketView`, `getLedgerProof`.
 */

export interface OwnershipDeps {
  db: PrismaClient;
  ledger: () => Pick<XrplQueryService, "getOwner" | "verifyOwner" | "getAccountNfts">;
  config: Pick<XrplConfig, "explorerUrl">;
}

/** Pages of 400 NFTs read for one wallet: up to 10,000 NFTs. */
const MAX_WALLET_PAGES = 25;

type OwnerRead =
  | { status: "VERIFIED"; owner: string; ledgerIndex: number }
  | { status: "BURNED"; ledgerIndex: number | null }
  | { status: "PENDING"; detail: string; ledgerError: boolean };

const LEDGER_UNREADABLE = "The XRP Ledger couldn't be read just now. Try again shortly.";
const UNSEEN_WALLET = "This ticket has moved to a wallet the app hasn't seen yet.";

type TicketForOwnership = {
  id: string;
  nftokenId: string | null;
  issuerAddress: string | null;
  cachedOwnerAddress: string | null;
};

/** Wallets that plausibly hold a ticket: on record, buyers through the app, its issuer. */
async function knownWallets(
  db: Pick<PrismaClient, "nFTOffer">,
  ticket: TicketForOwnership,
): Promise<string[]> {
  const buyers = await db.nFTOffer.findMany({
    where: { ticketId: ticket.id, state: "ACCEPTED", acceptedByAddress: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { acceptedByAddress: true },
  });
  const all = [ticket.cachedOwnerAddress, ...buyers.map((b) => b.acceptedByAddress), ticket.issuerAddress];
  return [...new Set(all.filter((a): a is string => !!a))];
}

/** The NFT's current owner on a validated ledger, or why that can't be said. */
async function readOwner(
  deps: OwnershipDeps,
  ticket: TicketForOwnership & { nftokenId: string },
): Promise<OwnerRead> {
  try {
    const answer = await deps.ledger().getOwner(ticket.nftokenId);
    const ledgerIndex = answer.provenance.ledgerIndex;
    if (!answer.provenance.validated || ledgerIndex === null) {
      return {
        status: "PENDING",
        detail: "The latest ledger isn't validated yet. Try again shortly.",
        ledgerError: true,
      };
    }
    if (answer.isBurned) return { status: "BURNED", ledgerIndex };
    return { status: "VERIFIED", owner: answer.ownerAddress, ledgerIndex };
  } catch (error) {
    if (!isXrplServiceError(error)) throw error;
    // No Clio node, or it has not indexed a new NFT yet: check the wallets the app knows on rippled.
    if (error.code !== "CONFIG_ERROR" && error.code !== "NOT_FOUND") {
      return { status: "PENDING", detail: LEDGER_UNREADABLE, ledgerError: true };
    }
  }
  try {
    for (const address of await knownWallets(deps.db, ticket)) {
      const check = await deps.ledger().verifyOwner(ticket.nftokenId, address);
      if (check.owns && check.provenance.validated && check.provenance.ledgerIndex !== null) {
        return { status: "VERIFIED", owner: address, ledgerIndex: check.provenance.ledgerIndex };
      }
    }
    return { status: "PENDING", detail: UNSEEN_WALLET, ledgerError: false };
  } catch (error) {
    if (!isXrplServiceError(error)) throw error;
    return { status: "PENDING", detail: LEDGER_UNREADABLE, ledgerError: true };
  }
}

/**
 * Resolves who holds a ticket now and refreshes the ticket's cached owner. A verified answer
 * from an older ledger never overwrites a newer one. 404 for an unknown ticket.
 */
export async function resolveTicketOwnership(
  deps: OwnershipDeps,
  input: { ticketId: string; viewerAddress?: string | null },
): Promise<TicketOwnership> {
  const ticket = await deps.db.ticketNFT.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      nftokenId: true,
      mintStatus: true,
      issuerAddress: true,
      cachedOwnerAddress: true,
    },
  });
  if (!ticket) throw errors.notFound("Ticket not found");
  const checkedAt = new Date();
  const base = {
    ticketId: ticket.id,
    nftokenId: ticket.nftokenId,
    checkedAt: checkedAt.toISOString(),
    previousOwnerAddress: ticket.cachedOwnerAddress,
    nftExplorerUrl: ticket.nftokenId ? explorerNftUrl(deps.config, ticket.nftokenId) : null,
  };
  if (ticket.mintStatus !== "MINTED" || !ticket.nftokenId) {
    return {
      ...base,
      status: "NOT_MINTED",
      ownerAddress: null,
      ledgerIndex: null,
      changed: false,
      ownedByViewer: false,
      detail: null,
    };
  }

  const read = await readOwner(deps, { ...ticket, nftokenId: ticket.nftokenId });
  if (read.status === "PENDING") {
    await deps.db.ticketNFT.update({
      where: { id: ticket.id },
      data: { ownerSyncStatus: read.ledgerError ? "ERROR" : "STALE" },
    });
    return {
      ...base,
      status: "PENDING",
      ownerAddress: null,
      ledgerIndex: null,
      changed: false,
      ownedByViewer: false,
      detail: read.detail,
    };
  }

  const owner = read.status === "VERIFIED" ? read.owner : null;
  await deps.db.ticketNFT.updateMany({
    where: {
      id: ticket.id,
      OR: [
        { ownerSyncLedgerIndex: null },
        ...(read.ledgerIndex === null ? [] : [{ ownerSyncLedgerIndex: { lte: read.ledgerIndex } }]),
      ],
    },
    data: {
      cachedOwnerAddress: owner,
      ownerSyncStatus: "SYNCED",
      ownerSyncedAt: checkedAt,
      ownerSyncLedgerIndex: read.ledgerIndex,
    },
  });
  return {
    ...base,
    status: read.status,
    ownerAddress: owner,
    ledgerIndex: read.ledgerIndex,
    changed: ticket.cachedOwnerAddress !== null && owner !== ticket.cachedOwnerAddress,
    ownedByViewer: !!owner && !!input.viewerAddress && owner === input.viewerAddress,
    detail: read.status === "BURNED" ? "This ticket's NFT no longer exists on the ledger." : null,
  };
}

/** Current verified owner of an NFT the app knows as a ticket, or null (`LedgerReadPort.getOwner`). */
export async function getTicketOwner(deps: OwnershipDeps, nftokenId: string): Promise<string | null> {
  const ticket = await deps.db.ticketNFT.findUnique({ where: { nftokenId }, select: { id: true } });
  if (!ticket) return null;
  return (await resolveTicketOwnership(deps, { ticketId: ticket.id })).ownerAddress;
}

const ticketViewInclude = {
  tier: { select: { name: true, priceDrops: true } },
  event: {
    select: {
      id: true,
      title: true,
      startsAt: true,
      venue: true,
      city: true,
      artworkUrl: true,
      seller: { select: { displayName: true } },
    },
  },
  checkIns: { select: { scannedAt: true }, orderBy: { scannedAt: "desc" as const }, take: 1 },
};

type TicketForView = NonNullable<
  Awaited<ReturnType<PrismaClient["ticketNFT"]["findUnique"]>> & {
    tier: { name: string; priceDrops: string };
    event: {
      id: string;
      title: string;
      startsAt: Date;
      venue: string;
      city: string;
      artworkUrl: string | null;
      seller: { displayName: string };
    };
    checkIns: Array<{ scannedAt: Date }>;
  }
>;

/** The latest validated transfer onto a ticket (a purchase through the app), or null. */
async function lastTransferTxHashes(
  db: Pick<PrismaClient, "ledgerTransaction">,
  ticketIds: string[],
): Promise<Map<string, string>> {
  if (ticketIds.length === 0) return new Map();
  const transfers = await db.ledgerTransaction.findMany({
    where: {
      relatedTicketId: { in: ticketIds },
      type: "NFTokenAcceptOffer",
      status: "VALIDATED_SUCCESS",
      hash: { not: null },
    },
    orderBy: { validatedAt: "asc" },
    select: { relatedTicketId: true, hash: true },
  });
  const latest = new Map<string, string>();
  for (const t of transfers) latest.set(t.relatedTicketId as string, t.hash as string);
  return latest;
}

function toTicketView(
  config: OwnershipDeps["config"],
  ticket: TicketForView,
  proof: { owner: string; ledgerIndex: number; verifiedAt: Date; lastTransferTxHash: string | null },
  viewerAddress: string | null | undefined,
): TicketView {
  const nftokenId = ticket.nftokenId as string;
  const mintTxHash = ticket.mintTxHash as string;
  const ledger: LedgerProof = {
    nftokenId,
    issuerAddress: ticket.issuerAddress as string,
    ownerAddress: proof.owner,
    mintTxHash,
    lastTransferTxHash: proof.lastTransferTxHash,
    metadataUri: ticket.metadataUri as string,
    ledgerIndex: proof.ledgerIndex,
    verifiedAt: proof.verifiedAt.toISOString(),
    explorerTxUrl: explorerTxUrl(config, proof.lastTransferTxHash ?? mintTxHash),
    explorerNftUrl: explorerNftUrl(config, nftokenId),
  };
  return {
    id: ticket.id,
    eventId: ticket.eventId,
    tierId: ticket.tierId,
    serial: ticket.serial,
    tierName: ticket.tier.name,
    priceDrops: ticket.tier.priceDrops,
    event: {
      id: ticket.event.id,
      title: ticket.event.title,
      startsAt: ticket.event.startsAt.toISOString(),
      venue: ticket.event.venue,
      city: ticket.event.city,
      artworkUrl: ticket.event.artworkUrl,
      sellerDisplayName: ticket.event.seller.displayName,
    },
    ledger,
    checkedInAt: ticket.checkIns[0]?.scannedAt.toISOString() ?? null,
    ownedByViewer: !!viewerAddress && viewerAddress === proof.owner,
  };
}

/**
 * Tickets a wallet holds right now, from its NFTs on a validated ledger (`account_nfts`), so
 * every ticket listed is verified. Refreshes the cache both ways: listed tickets now show this
 * wallet as owner, and tickets the app thought it held but it no longer does become STALE
 * (sold or transferred away). `LedgerReadPort.listTicketsForOwner` for My tickets (XRPL-033).
 */
export async function listTicketsForOwner(
  deps: OwnershipDeps,
  input: { address: string; viewerAddress?: string | null },
): Promise<TicketView[]> {
  const held = new Set<string>();
  let ledgerIndex: number | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_WALLET_PAGES; page += 1) {
    let result: Awaited<ReturnType<XrplQueryService["getAccountNfts"]>>;
    try {
      result = await deps.ledger().getAccountNfts(input.address, { cursor, limit: 400 });
    } catch (error) {
      // An address never funded on this network has no account, so it holds nothing.
      if (page === 0 && isXrplServiceError(error) && error.code === "NOT_FOUND") break;
      throw error;
    }
    for (const nft of result.items) held.add(nft.nftokenId);
    ledgerIndex ??= result.provenance.ledgerIndex;
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const tickets = (await deps.db.ticketNFT.findMany({
    where: { nftokenId: { in: [...held] }, mintStatus: "MINTED" },
    include: ticketViewInclude,
    orderBy: [{ event: { startsAt: "asc" } }, { serial: "asc" }],
  })) as TicketForView[];
  const ids = tickets.map((t) => t.id);
  const verifiedAt = new Date();
  await deps.db.$transaction([
    deps.db.ticketNFT.updateMany({
      where: { id: { in: ids } },
      data: {
        cachedOwnerAddress: input.address,
        ownerSyncStatus: "SYNCED",
        ownerSyncedAt: verifiedAt,
        ownerSyncLedgerIndex: ledgerIndex,
      },
    }),
    deps.db.ticketNFT.updateMany({
      where: { cachedOwnerAddress: input.address, id: { notIn: ids } },
      data: { ownerSyncStatus: "STALE" },
    }),
  ]);

  const transfers = await lastTransferTxHashes(deps.db, ids);
  return tickets.map((ticket) =>
    toTicketView(
      deps.config,
      ticket,
      {
        owner: input.address,
        ledgerIndex: ledgerIndex ?? 0,
        verifiedAt,
        lastTransferTxHash: transfers.get(ticket.id) ?? null,
      },
      input.viewerAddress,
    ),
  );
}

/**
 * One ticket with its ownership. `ticket` is the full view only when ownership is VERIFIED;
 * otherwise show `ownership.status` (e.g. PENDING), never an owner. (`LedgerReadPort.getTicket`
 * for the ticket view, XRPL-034.)
 */
export async function getTicketView(
  deps: OwnershipDeps,
  input: { ticketId: string; viewerAddress?: string | null },
): Promise<{ ticket: TicketView | null; ownership: TicketOwnership }> {
  const ownership = await resolveTicketOwnership(deps, input);
  if (ownership.status !== "VERIFIED" || !ownership.ownerAddress || ownership.ledgerIndex === null) {
    return { ticket: null, ownership };
  }
  const ticket = (await deps.db.ticketNFT.findUniqueOrThrow({
    where: { id: input.ticketId },
    include: ticketViewInclude,
  })) as TicketForView;
  const transfers = await lastTransferTxHashes(deps.db, [ticket.id]);
  return {
    ticket: toTicketView(
      deps.config,
      ticket,
      {
        owner: ownership.ownerAddress,
        ledgerIndex: ownership.ledgerIndex,
        verifiedAt: new Date(ownership.checkedAt),
        lastTransferTxHash: transfers.get(ticket.id) ?? null,
      },
      input.viewerAddress,
    ),
    ownership,
  };
}

/** The ledger proof for a ticket's NFT, or null unless its owner is verified (`LedgerReadPort`). */
export async function getLedgerProof(deps: OwnershipDeps, nftokenId: string): Promise<LedgerProof | null> {
  const row = await deps.db.ticketNFT.findUnique({ where: { nftokenId }, select: { id: true } });
  if (!row) return null;
  return (await getTicketView(deps, { ticketId: row.id })).ticket?.ledger ?? null;
}
