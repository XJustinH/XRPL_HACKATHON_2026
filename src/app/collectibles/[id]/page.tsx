import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import type { CollectibleView } from "@/contracts/collectibles";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { BuyCollectible } from "@/features/collectibles/buy-collectible";
import { MediaPreview, RightsNotice, TokenProof, tokenStatusLabel } from "@/features/collectibles/collectible-ui";
import { reconcileCollectible } from "@/features/collectibles/ledger";
import { findCollectible, toCollectibleView } from "@/features/collectibles/listings";
import { collectibleDeps } from "@/features/collectibles/server";
import { getCurrentSession } from "@/lib/auth/current-session";
import { AppError } from "@/lib/http/response";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

export const metadata = { title: "Digital collectible" };

/**
 * XRPL-072/074 — public listing of a digital collectible: the media, its creator, what a buyer
 * receives (and that copyright is not transferred), the editions with their on-chain proof, and
 * Buy for the next edition on sale. A draft is visible only to its seller.
 */
export default async function CollectiblePage({ params }: { params: Promise<{ id: string }> }) {
  // Sale state is live; never served from a cache.
  await connection();
  const { id } = await params;
  if (!AppId.safeParse(id).success) notFound();

  const session = await getCurrentSession();
  const deps = collectibleDeps();
  let collectible: CollectibleView;
  try {
    await findCollectible(deps.db, id, session?.userId ?? null);
    // Bring mints, listings and purchases in flight up to date (failures are logged, not fatal).
    await reconcileCollectible(deps, id);
    collectible = toCollectibleView(await findCollectible(deps.db, id, session?.userId ?? null), deps.config);
  } catch (error) {
    // Unknown, or someone else's draft. Anything else is a real failure for the error page.
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const isSeller = session?.userId === collectible.sellerId;
  const nextForSale = collectible.tokens.find((token) => token.forSale && token.saleStatus === "NONE") ?? null;
  const minted = collectible.tokens.filter((token) => token.mintStatus === "MINTED");

  return (
    <>
      <PageHeader
        title={collectible.title}
        description={`Digital collectible · edition of ${collectible.editionSize} · ${formatDropsAsXrp(collectible.priceDrops)} XRP each`}
        actions={isSeller ? <Link href="/seller/collectibles" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface">Manage</Link> : undefined}
      />
      {collectible.status === "DRAFT" ? (
        <p className="mb-4 rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">
          Draft: only you can see this page and its media until you publish it.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <MediaPreview media={collectible.media} title={collectible.title} />
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">Digital collectible</Badge>
            <Badge tone="neutral">Not a ticket</Badge>
          </div>
          <p className="text-sm">
            Created by{" "}
            <Link href={`/sellers/${collectible.sellerId}`} className="text-accent underline">
              {collectible.sellerName}
            </Link>
          </p>
          {collectible.description ? <p className="whitespace-pre-line text-sm">{collectible.description}</p> : null}
          <p className="text-sm text-muted">
            {collectible.mintedCount} of {collectible.editionSize} minted · {collectible.forSaleCount} for sale
          </p>
          {nextForSale ? (
            <BuyCollectible
              key={nextForSale.id}
              token={nextForSale}
              title={collectible.title}
              buyerAddress={session?.walletAddress ?? null}
            />
          ) : (
            <p className="rounded-lg bg-surface px-3 py-2 text-sm text-muted">
              No editions are for sale right now.
            </p>
          )}
          <RightsNotice statement={collectible.rightsStatement} />
        </div>
      </div>

      {minted.length > 0 ? (
        <section aria-labelledby="editions-heading" className="mt-10">
          <h2 id="editions-heading" className="mb-3 text-lg font-semibold">
            Editions on the XRP Ledger
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface-raised px-4">
            {minted.map((token) => (
              <li key={token.id} className="py-3">
                <p className="text-sm font-medium">
                  #{token.edition} of {token.editionSize} · {tokenStatusLabel(token)}
                </p>
                <TokenProof token={token} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
