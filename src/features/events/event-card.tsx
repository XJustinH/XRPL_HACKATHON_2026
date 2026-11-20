import Link from "next/link";
import { safeExternalUrl, type EventView } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { formatEventDate, formatXrp, lowestPriceDrops } from "./event-formatting";

/**
 * Event summary card for the public listing (XRPL-018).
 *
 * Artwork is rendered with a plain `img` rather than `next/image` because the
 * URL is seller-supplied and arbitrary; the optimiser would need every host
 * allow-listed up front. `onError` hides a broken link so a dead URL leaves a
 * tidy card instead of a browser error glyph.
 */
export function EventCard({ event }: { event: EventView }) {
  const fromPrice = lowestPriceDrops(event.tiers);
  // Re-checked at render: a row may predate the scheme restriction.
  const artworkUrl = safeExternalUrl(event.artworkUrl);
  const totalSupply = event.tiers.reduce((sum, tier) => sum + tier.totalSupply, 0);

  return (
    <article className="group overflow-hidden rounded-card border border-border bg-surface-raised transition-colors hover:border-accent">
      <Link href={`/events/${event.id}`} className="block focus-visible:outline-none">
        <div className="aspect-[16/9] w-full overflow-hidden bg-surface">
          {artworkUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
            <img
              src={artworkUrl}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="grid size-full place-items-center text-2xl font-semibold text-muted"
            >
              {event.title.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="p-4">
          <h3 className="font-semibold leading-snug group-hover:text-accent">
            {event.title}
          </h3>
          <p className="mt-1 text-sm text-muted">{formatEventDate(event.startsAt)}</p>
          <p className="text-sm text-muted">
            {event.venue}, {event.city}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {fromPrice !== null ? (
              <Badge tone="accent">From {formatXrp(fromPrice)}</Badge>
            ) : (
              <Badge>Price to be announced</Badge>
            )}
            {totalSupply > 0 ? (
              <span className="text-xs text-muted">
                {totalSupply} {totalSupply === 1 ? "ticket" : "tickets"}
              </span>
            ) : null}
          </div>

        </div>
      </Link>

      {/* Outside the card link: a link inside a link is invalid and unreachable
          by keyboard. */}
      <p className="px-4 pb-4 text-sm text-muted">
        by{" "}
        <Link
          href={`/sellers/${event.seller.id}`}
          className="font-medium text-ink hover:text-accent hover:underline"
        >
          {event.seller.displayName}
        </Link>
      </p>
    </article>
  );
}
