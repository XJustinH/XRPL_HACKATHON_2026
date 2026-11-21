import { connection } from "next/server";

import { PageHeader } from "@/components/ui/page-header";
import {
  BrowseCollectiblesSection,
  CollectionPrompt,
  OwnedCollectiblesSection,
} from "@/features/collectibles/sections";
import { getCurrentSession } from "@/lib/auth/current-session";

export const metadata = { title: "Digital collectibles" };

/**
 * XRPL-075 — the signed-in wallet's digital collectibles, kept apart from tickets.
 *
 * Only artist-made collectible NFTs are listed here, each checked on a validated ledger; tickets
 * live on `/tickets`. Below the collection, collectibles currently published by artists.
 */
export default async function CollectiblesPage() {
  // Ownership is live ledger state; never served from a cache.
  await connection();
  const session = await getCurrentSession();

  return (
    <>
      <PageHeader
        title="Digital collectibles"
        description="Artist-made NFTs: artwork, tracks and clips. They are merchandise, not tickets, and never grant entry to an event."
      />
      {session?.walletAddress ? (
        <OwnedCollectiblesSection walletAddress={session.walletAddress} />
      ) : (
        <CollectionPrompt signedIn={!!session} />
      )}
      <BrowseCollectiblesSection />
    </>
  );
}
