import Link from "next/link";
import { connection } from "next/server";

import { EVENT_MANAGER_ROLES } from "@/contracts/auth";
import type { CollectibleView } from "@/contracts/collectibles";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { reconcileSellerCollectibles } from "@/features/collectibles/ledger";
import { listSellerCollectibles, toCollectibleView } from "@/features/collectibles/listings";
import { SellerCollectiblesManager } from "@/features/collectibles/seller-collectibles-manager";
import { collectibleDeps } from "@/features/collectibles/server";
import { getCurrentSession } from "@/lib/auth/current-session";

export const metadata = { title: "Sell digital collectibles" };

const DESCRIPTION =
  "Upload artwork, a track or a clip, mint it as a numbered edition of NFTs from your own wallet, and sell it for XRP. Collectibles are merchandise, not tickets.";

/**
 * XRPL-070 to XRPL-074 — the seller's collectibles workspace: upload media with a rights
 * declaration, describe and publish it, mint each edition, and list minted editions for sale.
 */
export default async function SellerCollectiblesPage() {
  await connection();
  const session = await getCurrentSession();
  const canSell =
    !!session && !!session.onboardedAt && (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canSell) {
    return (
      <>
        <PageHeader title="Sell digital collectibles" />
        <EmptyState
          title={session ? "Your account can't sell collectibles" : "Sign in to sell collectibles"}
          description={
            session
              ? "Digital collectibles are sold by seller and organiser accounts."
              : "Create a seller profile, or use a demo seller account, to offer digital collectibles."
          }
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

  let collectibles: CollectibleView[] | null = null;
  try {
    const deps = collectibleDeps();
    await reconcileSellerCollectibles(deps, session.userId);
    const rows = await listSellerCollectibles(deps.db, session.userId, { includeDrafts: true });
    collectibles = rows.map((row) => toCollectibleView(row, deps.config));
  } catch (error) {
    console.error("[collectibles] could not load the seller's collectibles", error);
  }

  if (collectibles === null) {
    return (
      <>
        <PageHeader title="Sell digital collectibles" description={DESCRIPTION} />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your collectibles could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Sell digital collectibles" description={DESCRIPTION} />
      <SellerCollectiblesManager initial={collectibles} walletAddress={session.walletAddress} />
    </>
  );
}
