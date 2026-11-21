import Link from "next/link";

import {
  COPYRIGHT_NOTICE,
  NO_ENTRY_NOTICE,
  type CollectibleTokenView,
  type CollectibleView,
  type MediaAssetView,
} from "@/contracts/collectibles";
import { Badge } from "@/components/ui/badge";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

/**
 * Presentational pieces for digital collectibles (XRPL-072/075). No hooks and no server calls,
 * so both server pages and client components can render them.
 */

/** Image, audio or video preview, loaded from the access-checked media route. */
export function MediaPreview({
  media,
  title,
  compact = false,
}: {
  media: Pick<MediaAssetView, "kind" | "contentUrl">;
  title: string;
  compact?: boolean;
}) {
  const height = compact ? "max-h-48" : "max-h-[28rem]";
  if (media.kind === "IMAGE") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served by the app's own access-checked media route
      <img
        src={media.contentUrl}
        alt={title}
        loading="lazy"
        className={`${height} w-full rounded-lg bg-surface object-contain`}
      />
    );
  }
  if (media.kind === "AUDIO") {
    return <audio controls preload="none" src={media.contentUrl} aria-label={title} className="w-full" />;
  }
  return (
    <video
      controls
      playsInline
      preload="metadata"
      src={media.contentUrl}
      aria-label={title}
      className={`${height} w-full rounded-lg bg-black`}
    />
  );
}

/** What a buyer receives: the seller's statement, then the fixed copyright and no-entry notices. */
export function RightsNotice({ statement }: { statement: string }) {
  return (
    <section aria-labelledby="rights-heading" className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id="rights-heading" className="text-base font-semibold">
        What you get when you buy
      </h2>
      <p className="mt-2 whitespace-pre-line text-sm">{statement}</p>
      <p className="mt-3 rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">{COPYRIGHT_NOTICE}</p>
      <p className="mt-2 text-sm text-muted">{NO_ENTRY_NOTICE}</p>
    </section>
  );
}

/** One line describing where an edition is in its life. */
export function tokenStatusLabel(token: CollectibleTokenView): string {
  if (token.saleStatus === "SOLD") return "Sold";
  if (token.saleStatus === "PENDING") return "Purchase in progress";
  if (token.offerStatus === "ACTIVE") return `For sale · ${formatDropsAsXrp(token.offerAmountDrops ?? "0")} XRP`;
  if (token.offerStatus === "PENDING") return "Sale listing waiting for approval";
  if (token.offerStatus === "STALE") return "Minted · its sale listing is no longer on the ledger";
  if (token.mintStatus === "MINTED") return "Minted · not listed for sale";
  if (token.mintStatus === "PENDING") return "Mint waiting for approval";
  if (token.mintStatus === "SUBMITTED") return "Mint waiting for the ledger";
  if (token.mintStatus === "FAILED") return "Mint not completed";
  return "Not minted yet";
}

/* 24px tall: these small links sit side by side, and a thumb has to hit the right one (WCAG 2.5.8). */
const externalLink = "inline-flex min-h-6 items-center text-accent underline";

/** On-chain proof for a minted edition: the NFT ID and explorer links. */
export function TokenProof({ token }: { token: CollectibleTokenView }) {
  if (!token.nftokenId) return null;
  return (
    <div className="text-xs text-muted">
      <p className="break-all">
        NFT ID: <span className="font-mono">{token.nftokenId}</span>
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {token.nftExplorerUrl ? (
          <a href={token.nftExplorerUrl} target="_blank" rel="noopener noreferrer" className={externalLink}>
            View NFT on the explorer
          </a>
        ) : null}
        {token.mintTxExplorerUrl ? (
          <a href={token.mintTxExplorerUrl} target="_blank" rel="noopener noreferrer" className={externalLink}>
            Mint transaction
          </a>
        ) : null}
        {token.saleTxExplorerUrl ? (
          <a href={token.saleTxExplorerUrl} target="_blank" rel="noopener noreferrer" className={externalLink}>
            Purchase transaction
          </a>
        ) : null}
      </p>
    </div>
  );
}

/** A published collectible in a grid, linking to its listing page. */
export function CollectibleCard({ collectible }: { collectible: CollectibleView }) {
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
        </div>
        <p className="mt-1 text-sm text-muted">
          by {collectible.sellerName} · edition of {collectible.editionSize}
        </p>
        <p className="mt-1 text-sm">
          {formatDropsAsXrp(collectible.priceDrops)} XRP ·{" "}
          {collectible.forSaleCount > 0 ? `${collectible.forSaleCount} for sale` : "none for sale right now"}
        </p>
      </div>
    </article>
  );
}
