import { Badge } from "@/components/ui/badge";
import type { EventInventory } from "@/contracts/checkin";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

const COLUMNS = [
  { key: "total", label: "Total", hint: "Tickets offered" },
  { key: "minted", label: "Minted", hint: "Validated on XRPL" },
  { key: "onSale", label: "On sale", hint: "Live primary offer" },
  { key: "sold", label: "Sold", hint: "Validated purchase" },
  { key: "unsold", label: "Unsold", hint: "Total minus sold" },
] as const;

/** Per-tier inventory for the seller (XRPL-021). Phones: one card per tier; wider screens: a table. */
export function InventoryTable({ inventory }: { inventory: EventInventory }) {
  const { tiers, totals } = inventory;
  if (tiers.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">No ticket tiers yet.</p>
    );
  }
  return (
    <>
      <ul className="grid gap-3 sm:hidden" aria-label="Ticket tiers">
        {tiers.map((t) => (
          <li key={t.tierId} className="rounded-card border border-border bg-surface-raised p-4">
            <p className="font-semibold">
              {t.name} <span className="font-normal text-muted">· {formatDropsAsXrp(t.priceDrops)} XRP</span>
            </p>
            <dl className="mt-2 grid grid-cols-5 gap-1 text-center text-xs">
              {COLUMNS.map((c) => (
                <div key={c.key}>
                  <dt className="text-muted">{c.label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{t[c.key]}</dd>
                </div>
              ))}
            </dl>
            {t.minting > 0 ? <p className="mt-2 text-xs text-caution">{t.minting} minting, waiting for XRPL</p> : null}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-card border border-border sm:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Ticket inventory by tier</caption>
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Tier
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="px-4 py-3 text-right font-medium" title={c.hint}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tiers.map((t) => (
              <tr key={t.tierId}>
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  {t.name}
                  <span className="ml-2 font-normal text-muted">{formatDropsAsXrp(t.priceDrops)} XRP</span>
                  {t.minting > 0 ? (
                    <span className="ml-2">
                      <Badge tone="caution">{t.minting} minting</Badge>
                    </span>
                  ) : null}
                </th>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="px-4 py-3 text-right tabular-nums">
                    {t[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-surface font-semibold">
            <tr>
              <th scope="row" className="px-4 py-3 text-left">
                All tiers
              </th>
              {COLUMNS.map((c) => (
                <td key={c.key} className="px-4 py-3 text-right tabular-nums">
                  {totals[c.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
