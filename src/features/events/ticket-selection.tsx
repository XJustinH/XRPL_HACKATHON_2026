import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatXrp } from "./event-formatting";
import type { TierPurchaseState } from "./purchase-eligibility";

/**
 * Ticket types, prices and availability for one event (XRPL-019).
 *
 * Primary inventory only. Resale listings are a separate section with their own
 * rules, so a buyer can always tell which market a ticket comes from.
 */
export function TicketSelection({
  eventId,
  tiers,
}: {
  eventId: string;
  tiers: TierPurchaseState[];
}) {
  if (tiers.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
        No ticket types have been announced for this event yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {tiers.map((tier) => (
        <li
          key={tier.tierId}
          className="flex flex-col gap-3 rounded-card border border-border bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{tier.name}</h3>
              {tier.remaining <= 0 ? (
                <Badge tone="critical">Sold out</Badge>
              ) : tier.canBuy ? (
                <Badge tone="positive">On sale</Badge>
              ) : (
                <Badge tone="caution">{tier.blockedMessage}</Badge>
              )}
            </div>

            <p className="mt-1 text-sm text-muted">
              {/* Remaining comes from validated sales only, so it never
                  over-promises stock that is mid-purchase. */}
              {tier.remaining > 0
                ? `${tier.remaining} of ${tier.totalSupply} available`
                : `${tier.totalSupply} ${tier.totalSupply === 1 ? "ticket" : "tickets"}, all sold`}
              {tier.pending > 0 ? ` · ${tier.pending} purchase in progress` : null}
            </p>

            {tier.offer ? (
              <p className="mt-1 text-sm text-muted">
                Cheapest live offer {formatXrp(tier.offer.amountDrops)} · serial #
                {tier.offer.serial}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
            <p className="text-lg font-semibold">
              {formatXrp(tier.offer?.amountDrops ?? tier.priceDrops)}
            </p>
            {tier.canBuy && tier.offer ? (
              <Link
                href={`/events/${eventId}/purchase?tier=${encodeURIComponent(tier.tierId)}`}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Buy ticket
              </Link>
            ) : (
              <button
                type="button"
                disabled
                /* Disabled because no eligible primary offer exists, not as a
                   placeholder: the reason is stated next to it. */
                className="cursor-not-allowed rounded-lg border border-border px-4 py-2 text-sm font-semibold opacity-50"
              >
                Buy ticket
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
