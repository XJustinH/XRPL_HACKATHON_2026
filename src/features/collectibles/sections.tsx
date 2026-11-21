import Link from "next/link";

import { NO_ENTRY_NOTICE, type OwnedCollectible } from "@/contracts/collectibles";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getDb } from "@/lib/db/client";
import { loadXrplConfig } from "@/lib/xrpl/config";

import { CollectibleCard, MediaPreview, TokenProof } from "./collectible-ui";
import { listOwnedCollectibles } from "./ledger";
import { listPublishedCollectibles, listSellerCollectibles, toCollectibleView } from "./listings";
import { collectibleDeps } from "./server";

/**
 * Self-contained server components for digital collectibles (XRPL-072/075). Each loads its own
 * data and fails soft, so a page can mount one without any wiring.
 */

const linkButton = "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90";

/**
 * A seller's published collectibles, for their public storefront (`/sellers/:id`).
 * Renders nothing when the seller has none, or when they can't be loaded.
 */
export async function SellerCollectiblesSection({ sellerId }: { sellerId: string }) {
  let collectibles;
  try {
    const rows = await listSellerCollectibles(getDb(), sellerId, { includeDrafts: false });
    const config = loadXrplConfig();
    collectibles = rows.map((row) => toCollectibleView(row, config));
  } catch (error) {
    console.error("[collectibles] could not load a seller's collectibles", error);
    return null;
  }
  if (collectibles.length === 0) return null;
  return (
    <section aria-labelledby="seller-collectibles-heading" className="mt-10">
      <h2 id="seller-collectibles-heading" className="mb-1 text-lg font-semibold">
        Digital collectibles
      </h2>
      <p className="mb-4 text-sm text-muted">Artist-made NFTs. {NO_ENTRY_NOTICE}</p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {collectibles.map((collectible) => (
          <li key={collectible.id}>
            <CollectibleCard collectible={collectible} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Published collectibles from every seller, newest first. Renders nothing when there are none. */
export async function BrowseCollectiblesSection({ limit = 24 }: { limit?: number }) {
  let collectibles;
  try {
    const rows = await listPublishedCollectibles(getDb(), limit);
    const config = loadXrplConfig();
    collectibles = rows.map((row) => toCollectibleView(row, config));
  } catch (error) {
    console.error("[collectibles] could not load published collectibles", error);
    return null;
  }
  if (collectibles.length === 0) return null;
  return (
    <section aria-labelledby="browse-collectibles-heading" className="mt-10">
      <h2 id="browse-collectibles-heading" className="mb-4 text-lg font-semibold">
        Collectibles from artists
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {collectibles.map((collectible) => (
          <li key={collectible.id}>
            <CollectibleCard collectible={collectible} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OwnedCollectibleCard({ item }: { item: OwnedCollectible }) {
  const { token, collectible } = item;
  return (
    <article className="flex h-full flex-col gap-3 rounded-card border border-border bg-surface-raised p-4">
      <MediaPreview media={collectible.media} title={collectible.title} compact />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">
            <Link href={`/collectibles/${collectible.id}`} className="hover:underline">
              {collectible.title}
            </Link>
          </h3>
          <Badge tone="accent">Digital collectible</Badge>
          <Badge tone="positive">Owned · verified on ledger</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          Edition #{token.edition} of {token.editionSize} · created by{" "}
          <Link href={`/sellers/${collectible.sellerId}`} className="text-accent underline">
            {collectible.sellerName}
          </Link>
        </p>
        {collectible.description ? <p className="mt-2 text-sm">{collectible.description}</p> : null}
      </div>
      <TokenProof token={token} />
      <p className="text-xs text-muted">
        Held by your wallet {item.ownerAddress}
        {item.verifiedLedgerIndex !== null ? ` as of validated ledger ${item.verifiedLedgerIndex}` : ""}. Not a
        ticket: it does not grant entry to any event.
      </p>
    </article>
  );
}

/**
 * The collectible NFTs a wallet holds right now (XRPL-075), each checked on a validated ledger.
 * Only collectibles: tickets are listed on `/tickets` and are never mixed in here.
 * `walletAddress` must be the session's proven wallet.
 */
export async function OwnedCollectiblesSection({ walletAddress }: { walletAddress: string }) {
  let owned: OwnedCollectible[] | null = null;
  try {
    owned = await listOwnedCollectibles(collectibleDeps(), { address: walletAddress });
  } catch (error) {
    console.error("[collectibles] could not verify owned collectibles", error);
  }
  return (
    <section aria-labelledby="owned-collectibles-heading">
      <h2 id="owned-collectibles-heading" className="mb-1 text-lg font-semibold">
        Your collection
      </h2>
      <p className="mb-4 text-sm text-muted">
        Artist-made digital merchandise held by your wallet. {NO_ENTRY_NOTICE} Your tickets are under{" "}
        <Link href="/tickets" className="text-accent underline">
          My tickets
        </Link>
        .
      </p>
      {owned === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your collectibles could not be checked on the XRP Ledger right now. Refresh to try again.
        </p>
      ) : owned.length === 0 ? (
        <EmptyState
          title="No digital collectibles yet"
          description="Collectibles you buy from artists appear here once the XRP Ledger confirms the purchase."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {owned.map((item) => (
            <li key={item.token.id}>
              <OwnedCollectibleCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Sign-in or connect prompt shown in place of the collection. */
export function CollectionPrompt({ signedIn }: { signedIn: boolean }) {
  return (
    <EmptyState
      title={signedIn ? "Connect your wallet" : "Sign in to see your collection"}
      description={
        signedIn
          ? "Collectibles are NFTs held by your wallet. Prove control of it to see the ones it holds."
          : "Digital collectibles you own live in your wallet. Sign in and connect it to see them here."
      }
      action={
        <Link href={signedIn ? "/connect" : "/onboarding"} className={linkButton}>
          {signedIn ? "Connect your wallet" : "Get started"}
        </Link>
      }
    />
  );
}
