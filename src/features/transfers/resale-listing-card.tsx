import Link from "next/link";

import type { ResaleListing } from "@/contracts/events";
import { Badge } from "@/components/ui/badge";
import { formatEventDate } from "@/features/events/event-formatting";
import { explorerTxUrl } from "@/lib/xrpl/explorer";
import { loadXrplConfig } from "@/lib/xrpl/config";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { shortAddress } from "./api";

const listedOn = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Explorer link for the offer's creation, which is recorded only once validated. Null if unavailable. */
function offerProofUrl(createTxHash: string): string | null {
  try {
    return explorerTxUrl(loadXrplConfig(), createTxHash);
  } catch {
    return null;
  }
}

/**
 * One public resale listing (XRPL-038): the ticket, the asking price against face value, and the
 * seller's offer with its ledger proof. Used on /resale and on the event page, which leaves out the
 * event details it already shows.
 */
export function ResaleListingCard({ listing, showEvent = true }: { listing: ResaleListing; showEvent?: boolean }) {
  const proofUrl = offerProofUrl(listing.createTxHash);
  const listed = new Date(listing.createdAt);

  return (
    <article className="flex h-full flex-col rounded-card border border-border bg-surface-raised p-4">
      {showEvent ? (
        <>
          <h3 className="font-semibold leading-snug">{listing.event.title}</h3>
          <p className="mt-1 text-sm text-muted">{formatEventDate(listing.event.startsAt)}</p>
          <p className="text-sm text-muted">
            {listing.event.venue}, {listing.event.city}
          </p>
        </>
      ) : null}
      <p className={showEvent ? "mt-3 text-sm" : "text-sm"}>
        <span className="font-medium">{listing.ticket.tierName}</span>
        <span className="text-muted"> · #{listing.ticket.serial}</span>
      </p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">{formatDropsAsXrp(listing.amountDrops)} XRP</span>
        <span className="text-muted"> · face value {formatDropsAsXrp(listing.ticket.faceValueDrops)} XRP</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="positive">On sale</Badge>
        <span>
          by <span className="font-mono">{shortAddress(listing.sellerAddress)}</span>
          {Number.isNaN(listed.getTime()) ? null : <> · listed {listedOn.format(listed)}</>}
        </span>
        {proofUrl ? (
          <a href={proofUrl} target="_blank" rel="noopener noreferrer" className="underline">
            offer on the ledger
          </a>
        ) : null}
      </div>
      <div className="mt-auto pt-4">
        <Link
          href={`/offers/${listing.offerId}`}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90"
        >
          View and buy
        </Link>
      </div>
    </article>
  );
}
