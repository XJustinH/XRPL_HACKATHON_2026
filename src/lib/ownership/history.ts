import type { TicketHistory, TicketHistoryEntry, TicketOwnership, TransferKind } from "@/contracts";
import type { OfferKind, PrismaClient } from "@/generated/prisma/client";
import { errors } from "@/lib/http/response";
import type { XrplConfig } from "@/lib/xrpl/config";
import { explorerTxUrl } from "@/lib/xrpl/explorer";

/**
 * A ticket's transfer history (XRPL-043). Owner: Agent A.
 *
 * Built from what the app recorded from validated transactions: the mint, then each of the app's
 * offers that was accepted (primary sale, resale, private sale or gift), in ledger order. Each one
 * names who held the ticket before and after. Wherever that chain doesn't join up, the ticket moved
 * outside the app:
 *  - a later offer was made by someone other than the last known holder, or
 *  - the holder on a validated ledger now isn't the last known holder.
 * Those gaps become OUTSIDE_APP entries. The app saw only the result there, so it can't say how or
 * when the ticket moved, or how many wallets it passed through. Nothing is stored for them: the
 * history is worked out from the records and the verified holder each time it's read.
 */

const TRANSFER_KINDS: Record<OfferKind, TransferKind> = {
  PRIMARY: "PRIMARY_SALE",
  RESALE: "RESALE",
  PRIVATE: "PRIVATE_SALE",
  GIFT: "GIFT",
};

/** The holder read from a validated ledger, as `resolveTicketOwnership` reports it. */
export type CurrentHolder = Pick<TicketOwnership, "status" | "ownerAddress" | "ledgerIndex">;

export type RecordedMint = { issuerAddress: string; txHash: string; ledgerIndex: number | null; at: Date | null };

export type RecordedTransfer = {
  kind: OfferKind;
  /** The offer's owner, who held the ticket when the offer was validated. */
  fromAddress: string;
  /** Who accepted it: the new holder, or the broker in a brokered sale. */
  toAddress: string | null;
  amountDrops: string;
  txHash: string | null;
  ledgerIndex: number | null;
  at: Date | null;
  /** Ledger of the offer's own creation, the latest point at which its owner is known to have held it. */
  listedLedgerIndex: number | null;
};

const outsideApp = (fromAddress: string, toAddress: string | null, ledgerIndex: number | null): TicketHistoryEntry => ({
  kind: toAddress === null ? "BURNED" : "OUTSIDE_APP",
  source: "EXTERNAL",
  fromAddress,
  toAddress,
  amountDrops: null,
  txHash: null,
  explorerTxUrl: null,
  ledgerIndex,
  at: null,
});

/** The history from the app's records (transfers in ledger order) and the current holder. Pure. */
export function buildTicketHistory(input: {
  mint: RecordedMint | null;
  transfers: readonly RecordedTransfer[];
  current: CurrentHolder | null;
  txUrl: (hash: string) => string;
}): TicketHistoryEntry[] {
  const entries: TicketHistoryEntry[] = [];
  let holder: string | null = null;

  if (input.mint) {
    entries.push({
      kind: "MINT",
      source: "PLATFORM",
      fromAddress: null,
      toAddress: input.mint.issuerAddress,
      amountDrops: null,
      txHash: input.mint.txHash,
      explorerTxUrl: input.txUrl(input.mint.txHash),
      ledgerIndex: input.mint.ledgerIndex,
      at: input.mint.at?.toISOString() ?? null,
    });
    holder = input.mint.issuerAddress;
  }

  for (const transfer of input.transfers) {
    if (holder !== null && transfer.fromAddress !== holder) {
      entries.push(outsideApp(holder, transfer.fromAddress, transfer.listedLedgerIndex ?? transfer.ledgerIndex));
    }
    entries.push({
      kind: TRANSFER_KINDS[transfer.kind],
      source: "PLATFORM",
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      amountDrops: transfer.amountDrops,
      txHash: transfer.txHash,
      explorerTxUrl: transfer.txHash ? input.txUrl(transfer.txHash) : null,
      ledgerIndex: transfer.ledgerIndex,
      at: transfer.at?.toISOString() ?? null,
    });
    holder = transfer.toAddress;
  }

  const current = input.current;
  if (holder !== null && current?.status === "VERIFIED" && current.ownerAddress && current.ownerAddress !== holder) {
    entries.push(outsideApp(holder, current.ownerAddress, current.ledgerIndex));
  }
  if (holder !== null && current?.status === "BURNED") entries.push(outsideApp(holder, null, current.ledgerIndex));
  return entries;
}

/**
 * Loads a ticket's recorded mint and accepted offers and builds its history against `current`, the
 * holder just read from a validated ledger (null or PENDING when it couldn't be). 404 for an
 * unknown ticket.
 */
export async function getTicketHistory(
  deps: { db: Pick<PrismaClient, "ticketNFT" | "nFTOffer" | "ledgerTransaction">; config: Pick<XrplConfig, "explorerUrl"> },
  ticketId: string,
  current: CurrentHolder | null,
): Promise<TicketHistory> {
  const ticket = await deps.db.ticketNFT.findUnique({
    where: { id: ticketId },
    select: { id: true, nftokenId: true, mintStatus: true, issuerAddress: true, mintTxHash: true, mintedAt: true },
  });
  if (!ticket) throw errors.notFound("Ticket not found");

  const accepted = await deps.db.nFTOffer.findMany({
    where: { ticketId, state: "ACCEPTED" },
    select: {
      kind: true,
      ownerAddress: true,
      acceptedByAddress: true,
      amountDrops: true,
      acceptTxHash: true,
      createTxHash: true,
      updatedAt: true,
    },
  });
  const minted = ticket.mintStatus === "MINTED" && ticket.issuerAddress && ticket.mintTxHash ? ticket : null;
  const hashes = [
    minted?.mintTxHash,
    ...accepted.flatMap((o) => [o.acceptTxHash, o.createTxHash]),
  ].filter((h): h is string => !!h);
  const txs = new Map(
    (
      await deps.db.ledgerTransaction.findMany({
        where: { hash: { in: hashes } },
        select: { hash: true, ledgerIndex: true, validatedAt: true },
      })
    ).map((t) => [t.hash as string, t]),
  );

  const transfers: (RecordedTransfer & { order: number })[] = accepted.map((o) => {
    const acceptTx = o.acceptTxHash ? txs.get(o.acceptTxHash) : undefined;
    return {
      kind: o.kind,
      fromAddress: o.ownerAddress,
      toAddress: o.acceptedByAddress,
      amountDrops: o.amountDrops,
      txHash: o.acceptTxHash,
      ledgerIndex: acceptTx?.ledgerIndex ?? null,
      at: acceptTx?.validatedAt ?? null,
      listedLedgerIndex: (o.createTxHash ? txs.get(o.createTxHash)?.ledgerIndex : null) ?? null,
      order: (acceptTx?.validatedAt ?? o.updatedAt).getTime(),
    };
  });
  // Ledger order; the time breaks ties and orders any transfer whose ledger wasn't recorded.
  transfers.sort(
    (a, b) => (a.ledgerIndex ?? Number.MAX_SAFE_INTEGER) - (b.ledgerIndex ?? Number.MAX_SAFE_INTEGER) || a.order - b.order,
  );

  const mintTx = minted ? txs.get(minted.mintTxHash as string) : undefined;
  return {
    ticketId: ticket.id,
    nftokenId: ticket.nftokenId,
    entries: buildTicketHistory({
      mint: minted
        ? {
            issuerAddress: minted.issuerAddress as string,
            txHash: minted.mintTxHash as string,
            ledgerIndex: mintTx?.ledgerIndex ?? null,
            at: mintTx?.validatedAt ?? minted.mintedAt,
          }
        : null,
      transfers,
      current,
      txUrl: (hash) => explorerTxUrl(deps.config, hash),
    }),
    ownerVerified: current?.status === "VERIFIED" || current?.status === "BURNED",
  };
}
