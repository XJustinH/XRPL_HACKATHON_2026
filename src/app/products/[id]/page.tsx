import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PHYSICAL_MERCH_LABEL, type PhysicalProductDto } from "@/contracts/commerce";
import { Badge } from "@/components/ui/badge";
import { AddToCart } from "@/features/commerce/add-to-cart";
import { getProduct } from "@/features/commerce/products";
import { StockBadge } from "@/features/commerce/seller-merch-section";
import { commerceDeps } from "@/features/commerce/server";
import { notice } from "@/features/wallet/styles";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

export const metadata = { title: "Merchandise" };

/**
 * One physical product (XRPL-066): photos, price, stock and the add-to-cart control.
 *
 * Published products are public. A draft or archived product is 404 for everyone but its seller,
 * who sees it with a notice and without a way to add it to a cart. A product with no stock can't
 * be added either. The page is labelled "Physical merchandise" so it is never taken for an NFT.
 */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const session = await getCurrentSession();
  const db = getDb();
  let product: PhysicalProductDto;
  try {
    product = await getProduct(commerceDeps(db), id.data, session);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const seller = await db.user.findUnique({ where: { id: product.sellerId }, select: { displayName: true } });
  const onSale = product.status === "PUBLISHED";
  const [cover, ...otherImages] = product.imageUrls;

  return (
    <article className="grid gap-8 lg:grid-cols-2">
      <div>
        <div className="aspect-square w-full overflow-hidden rounded-card border border-border bg-surface">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
            <img src={cover} alt={`Photo of ${product.name}`} className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center text-sm text-muted">No photo</div>
          )}
        </div>
        {otherImages.length > 0 ? (
          <ul className="mt-3 grid grid-cols-4 gap-3">
            {otherImages.map((url, index) => (
              <li key={url} className="aspect-square overflow-hidden rounded-lg border border-border bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host */}
                <img src={url} alt={`${product.name}, photo ${index + 2}`} className="size-full object-cover" />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <Badge>{PHYSICAL_MERCH_LABEL}</Badge>
          {onSale ? <StockBadge stock={product.stock} /> : <Badge tone="caution">Not on sale</Badge>}
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{product.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Sold by{" "}
          <Link href={`/sellers/${product.sellerId}`} className="font-medium text-accent underline">
            {seller?.displayName ?? "this seller"}
          </Link>
        </p>
        <p className="mt-4 text-2xl font-semibold">{formatDropsAsXrp(product.priceDrops)} XRP</p>

        {!onSale ? (
          <p role="status" className={`${notice.caution} mt-4`}>
            Only you can see this page: the product is {product.status === "DRAFT" ? "a draft" : "archived"}. Publish it
            from{" "}
            <Link href="/seller/products" className="font-semibold underline">
              your merchandise page
            </Link>{" "}
            to put it on sale.
          </p>
        ) : null}

        <div className="mt-5">
          <AddToCart productId={product.id} name={product.name} stock={product.stock} onSale={onSale} />
        </div>

        {product.description ? (
          <p className="mt-6 max-w-prose whitespace-pre-line text-sm">{product.description}</p>
        ) : null}

        <p className="mt-6 text-sm text-muted">
          This is an ordinary physical item that the seller posts to you. It is not an NFT, and it is separate from
          tickets and digital collectibles.{" "}
          <Link href={`/sellers/${product.sellerId}/merch`} className="font-medium text-accent underline">
            More merchandise from this seller
          </Link>
        </p>
      </div>
    </article>
  );
}
