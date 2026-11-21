import type { TicketHistory, TicketHistoryEntry } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { formatEventDate, formatXrp } from "@/features/events/event-formatting";
import { shortAddress } from "@/features/transfers/api";
import { card } from "@/features/wallet/styles";

/**
 * A ticket's transfer history (XRPL-043): what the app recorded from validated transactions, and
 * where the ticket moved outside the app. Server-rendered from `getTicketHistory`.
 */

const LABELS: Record<TicketHistoryEntry["kind"], string> = {
  MINT: "Minted",
  PRIMARY_SALE: "Sold by the organiser",
  RESALE: "Resold",
  PRIVATE_SALE: "Sold privately",
  GIFT: "Gifted",
  OUTSIDE_APP: "Moved outside the app",
  BURNED: "NFT destroyed outside the app",
};

function price(entry: TicketHistoryEntry): string | null {
  if (entry.amountDrops === null) return null;
  return entry.kind === "GIFT" ? "Free" : formatXrp(entry.amountDrops);
}

function Parties({ entry }: { entry: TicketHistoryEntry }) {
  const address = (value: string) => (
    <span className="font-mono" title={value}>
      {shortAddress(value)}
    </span>
  );
  if (entry.kind === "MINT" && entry.toAddress) return <>To {address(entry.toAddress)}</>;
  if (entry.kind === "BURNED" && entry.fromAddress) return <>Last held by {address(entry.fromAddress)}</>;
  if (!entry.fromAddress || !entry.toAddress) return null;
  return (
    <>
      {address(entry.fromAddress)} <span aria-hidden="true">→</span>
      <span className="sr-only">to</span> {address(entry.toAddress)}
    </>
  );
}

export function TicketHistorySection({ history }: { history: TicketHistory }) {
  return (
    <section aria-labelledby="ticket-history-heading" className={card}>
      <h2 id="ticket-history-heading" className="text-lg font-semibold">
        History
      </h2>
      {history.entries.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing has been recorded for this ticket yet.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-4">
          {history.entries.map((entry, index) => {
            const external = entry.source === "EXTERNAL";
            const amount = price(entry);
            return (
              <li key={`${entry.kind}-${entry.txHash ?? index}`} className="border-l-2 border-border pl-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{LABELS[entry.kind]}</span>
                  {external ? <Badge tone="caution">Outside the app</Badge> : <Badge tone="positive">Recorded</Badge>}
                  {amount ? <span className="text-sm">{amount}</span> : null}
                </div>
                <p className="mt-1 text-sm">
                  <Parties entry={entry} />
                </p>
                {external ? (
                  <p className="mt-1 text-xs text-muted">
                    The app didn&apos;t make this move, so it can&apos;t say when or how it happened, or whether the
                    ticket passed through other wallets on the way.
                    {entry.ledgerIndex !== null ? ` Seen on the ledger by ledger ${entry.ledgerIndex.toLocaleString("en")}.` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {entry.at ? `${formatEventDate(entry.at)} · ` : ""}
                    {entry.ledgerIndex !== null ? `Ledger ${entry.ledgerIndex.toLocaleString("en")} · ` : ""}
                    {entry.explorerTxUrl ? (
                      <a href={entry.explorerTxUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        transaction
                      </a>
                    ) : null}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {history.ownerVerified ? null : (
        <p className="mt-4 text-sm text-muted">
          The current holder couldn&apos;t be read from the ledger just now, so any later moves aren&apos;t shown yet.
        </p>
      )}
    </section>
  );
}
