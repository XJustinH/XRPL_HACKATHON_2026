import Link from "next/link";
import { safeExternalUrl, type TicketView } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { formatEventDate, isPastEvent } from "@/features/events/event-formatting";

/**
 * One owned ticket, for the wallet's ticket collection (XRPL-033).
 *
 * Every ticket shown here was confirmed against the ledger by the caller, so
 * this component never has to qualify ownership — a ticket that has been
 * transferred away is absent, not greyed out.
 */
export function TicketCard({ ticket }: { ticket: TicketView }) {
  const artworkUrl = safeExternalUrl(ticket.event.artworkUrl);
  const past = isPastEvent(ticket.event.startsAt);
  const checkedIn = ticket.checkedInAt !== null;

  return (
    <article className="group overflow-hidden rounded-card border border-border bg-surface-raised transition-colors hover:border-accent">
      <Link href={`/tickets/${ticket.id}`} className="block">
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
              {ticket.event.title.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold leading-snug group-hover:text-accent">
              {ticket.event.title}
            </h3>
            {/* Check-in state is the thing a holder most needs at the door. */}
            {checkedIn ? (
              <Badge tone="positive">Checked in</Badge>
            ) : past ? (
              <Badge tone="neutral">Not used</Badge>
            ) : (
              <Badge tone="accent">Valid</Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-muted">{formatEventDate(ticket.event.startsAt)}</p>
          <p className="text-sm text-muted">
            {ticket.event.venue}, {ticket.event.city}
          </p>

          <p className="mt-3 text-sm">
            <span className="font-medium">{ticket.tierName}</span>
            <span className="text-muted"> · #{ticket.serial}</span>
          </p>

          {checkedIn ? (
            <p className="mt-1 text-xs text-muted">
              Entered {formatEventDate(ticket.checkedInAt!)}
            </p>
          ) : null}
        </div>
      </Link>
    </article>
  );
}
