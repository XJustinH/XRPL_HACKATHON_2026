import Link from "next/link";
import { PHYSICAL_MERCH_LABEL, type PhysicalProductDto } from "@/contracts/commerce";
import { Badge } from "@/components/ui/badge";
import { formatDropsAsXrp } from "@/lib/xrpl/format";
import { listSellerProducts } from "./products";
import { commerceDeps } from "./server";

/**
 * A seller's published merchandise for the public storefront (XRPL-065/066).
 *
 * Self-contained server component: mount it on `/sellers/[id]` with the seller's id. It always
 * reads as a visitor would, so drafts and archived products never appear, even for the seller.
 * Every card carries the "Physical merchandise" label so ordinary goods are never mistaken for
 * digital collectibles.
 */

export function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) return <Badge tone="critical">Out of stock</Badge>;
  if (stock <= 5) return <Badge tone="caution">Only {stock} left</Badge>;
  return <Badge tone="positive">In stock</Badge>;
}

export function ProductCard({ product }: { product: PhysicalProductDto }) {
  const cover = product.imageUrls[0];
  return (
    <Link
      href={`/products/${product.id}`}
      className="flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface-raised hover:border-accent"
    >
      <div className="aspect-square w-full bg-surface">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
          <img src={cover} alt="" className="size-full object-cover" />
        ) : (
          <div aria-hidden="true" className="grid size-full place-items-center text-sm text-muted">
            No photo
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap gap-2">
          <Badge>{PHYSICAL_MERCH_LABEL}</Badge>
          <StockBadge stock={product.stock} />
        </div>
        <p className="font-semibold">{product.name}</p>
        <p className="mt-auto text-sm text-muted">{formatDropsAsXrp(product.priceDrops)} XRP</p>
      </div>
    </Link>
  );
}

export async function SellerMerchSection({ sellerId }: { sellerId: string }) {
  let products: PhysicalProductDto[] | null = null;
  try {
    products = await listSellerProducts(commerceDeps(), sellerId, null);
  } catch (error) {
    // A merchandise failure must not take the rest of the storefront down.
    console.error("[commerce] could not load seller merchandise", error);
  }

  return (
    <section aria-labelledby="merch-heading" className="mt-10">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id="merch-heading" className="text-lg font-semibold">
          Merchandise
        </h2>
        <Badge>{PHYSICAL_MERCH_LABEL}</Badge>
      </div>
      {products === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Merchandise could not be loaded. Refresh to try again.
        </p>
      ) : products.length === 0 ? (
        <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
          No merchandise on sale right now.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            Ordinary goods posted to you. These are not NFTs and are separate from tickets and digital collectibles.
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
