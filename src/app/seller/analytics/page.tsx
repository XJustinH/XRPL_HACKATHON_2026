import Link from "next/link";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import type { LedgerSaleCheck, StorefrontMetrics } from "@/contracts/analytics";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { checkSalesOnLedger, getStorefrontMetrics } from "@/features/analytics/storefront-metrics";
import {
  CollectiblesSection,
  MerchandiseSection,
  TicketSummarySection,
} from "@/features/analytics/storefront-sections";
import { collectibleDeps } from "@/features/collectibles/server";
import { RefreshButton } from "@/features/organiser/refresh-button";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { loadXrplConfig } from "@/lib/xrpl/config";

export const metadata = { title: "Storefront analytics" };

/**
 * XRPL-078: a seller's storefront summary. Ticket sales, physical merchandise orders and digital
 * collectible sales are shown separately, each with its currency, how it settles and how its total
 * reconciles with the records behind it. Reads only the signed-in account's own records.
 */
export default async function StorefrontAnalyticsPage() {
  const session = await getCurrentSession();
  const canView =
    !!session && !!session.onboardedAt && (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canView) {
    return (
      <>
        <PageHeader title="Storefront analytics" />
        <EmptyState
          title={session ? "Your account has no storefront" : "Sign in to see your analytics"}
          description="Storefront analytics are for seller and organiser accounts."
          action={
            <Link
              href="/onboarding"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Get started
            </Link>
          }
        />
      </>
    );
  }

  let metrics: StorefrontMetrics | null = null;
  try {
    metrics = await getStorefrontMetrics(getDb(), session.userId, loadXrplConfig());
  } catch (error) {
    console.error("[analytics] could not load storefront metrics", error);
  }

  // Read the most recent sales again from the ledger. Optional: the page is complete without it.
  let checks: LedgerSaleCheck[] = [];
  if (metrics && metrics.collectibles.sales.length > 0) {
    try {
      checks = await checkSalesOnLedger(collectibleDeps().ledger(), metrics.collectibles.sales);
    } catch (error) {
      console.error("[analytics] could not check collectible sales on the ledger", error);
    }
  }

  return (
    <>
      <PageHeader
        title="Storefront analytics"
        description="Tickets, physical merchandise and digital collectibles, reported separately. They settle differently, so they are never added together."
        actions={<RefreshButton />}
      />

      {metrics === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your analytics could not be loaded. Refresh to try again.
        </p>
      ) : (
        <>
          <TicketSummarySection tickets={metrics.tickets} />
          <MerchandiseSection merchandise={metrics.merchandise} />
          <CollectiblesSection collectibles={metrics.collectibles} checks={checks} />
          <p className="mt-6 text-sm text-muted">
            All amounts are in XRP. Ticket and collectible figures count only transactions validated on the XRP Ledger;
            merchandise figures are order values with simulated payment. Updated{" "}
            {new Date(metrics.calculatedAt).toUTCString()}.
          </p>
        </>
      )}
    </>
  );
}
