import type { CheckInOverview } from "@/contracts/checkin";
import { shortAddress } from "@/features/checkin/gate-scanner";

/** Entry count and recent admissions for the organiser's gate screen (XRPL-048). */
export function EntryOverview({ overview }: { overview: CheckInOverview }) {
  const { admitted, mintedTickets, recent } = overview;
  return (
    <section aria-labelledby="entry-heading" className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id="entry-heading" className="text-lg font-semibold">
        Entry so far
      </h2>
      <p className="mt-2 text-3xl font-semibold tabular-nums">
        {admitted}
        <span className="text-base font-normal text-muted"> / {mintedTickets} tickets</span>
      </p>
      {recent.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No one has been checked in yet.</p>
      ) : (
        <ol className="mt-4 divide-y divide-border text-sm" aria-label="Recent check-ins">
          {recent.map((r) => (
            <li key={r.ticketId} className="flex items-center justify-between gap-3 py-2">
              <span>
                {r.tierName} #{r.serial}
                <span className="ml-2 font-mono text-xs text-muted">{shortAddress(r.walletAddress)}</span>
              </span>
              <time dateTime={r.scannedAt} className="shrink-0 text-muted tabular-nums">
                {new Date(r.scannedAt).toISOString().slice(11, 16)} UTC
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
