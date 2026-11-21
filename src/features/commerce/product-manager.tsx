"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  MAX_PRODUCT_IMAGES,
  PRODUCT_STATUS_CHANGES,
  type PhysicalProductDto,
  type ProductStatus,
} from "@/contracts/commerce";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { requestJson } from "@/features/events/api-client";
import { dropsToXrpInput, xrpToDrops } from "@/features/events/event-formatting";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

/**
 * A seller's merchandise manager (XRPL-065): create a product, edit its details and photos, change
 * its stock, and publish or withdraw it.
 *
 * Every action goes to an endpoint that checks on the server that the signed-in account owns the
 * product. Nothing here can name another seller: creation uses `/api/sellers/me/products`.
 */

const STATUS_BADGE: Record<ProductStatus, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  PUBLISHED: { label: "Published", tone: "positive" },
  ARCHIVED: { label: "Archived", tone: "caution" },
};

/** Button text for moving a product from one status to another. */
function statusAction(from: ProductStatus, to: ProductStatus): string {
  if (to === "PUBLISHED") return "Publish";
  if (to === "ARCHIVED") return "Archive";
  return from === "ARCHIVED" ? "Restore as draft" : "Unpublish";
}

const inputClass = "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base";
const labelClass = "block text-sm font-medium";

/** One https URL per line. Blank lines are ignored. */
export function parseImageUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Create form when `product` is absent, edit form (without stock) when it is given. */
function ProductForm({ product, onDone }: { product?: PhysicalProductDto; onDone: () => void }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(product ? dropsToXrpInput(product.priceDrops) : "");
  const [images, setImages] = useState(product?.imageUrls.join("\n") ?? "");
  const [stock, setStock] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const parsedPrice = xrpToDrops(price);
    if (!parsedPrice.ok) return setError(parsedPrice.message);
    const imageUrls = parseImageUrls(images);
    if (imageUrls.length > MAX_PRODUCT_IMAGES) return setError(`Add at most ${MAX_PRODUCT_IMAGES} photos.`);
    const openingStock = Number(stock);
    if (!product && (!Number.isInteger(openingStock) || openingStock < 0)) {
      return setError("Stock must be a whole number, 0 or more.");
    }

    setPending(true);
    setError(null);
    const details = { name, description, priceDrops: parsedPrice.drops, imageUrls };
    const result = product
      ? await requestJson<PhysicalProductDto>(`/api/products/${product.id}`, { method: "PATCH", body: details })
      : await requestJson<PhysicalProductDto>("/api/sellers/me/products", {
          method: "POST",
          body: { ...details, stock: openingStock },
        });
    setPending(false);

    if (!result.ok) return setError(result.message);
    if (!product) {
      setName("");
      setDescription("");
      setPrice("");
      setImages("");
      setStock("0");
    }
    onDone();
    router.refresh();
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor={`${id}-name`} className={labelClass}>
          Product name
        </label>
        <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label htmlFor={`${id}-description`} className={labelClass}>
          Description
        </label>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-price`} className={labelClass}>
            Price (XRP)
          </label>
          <input
            id={`${id}-price`}
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className={inputClass}
          />
        </div>
        {product ? null : (
          <div>
            <label htmlFor={`${id}-stock`} className={labelClass}>
              Stock (units)
            </label>
            <input
              id={`${id}-stock`}
              type="number"
              min={0}
              step={1}
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-images`} className={labelClass}>
          Photos
        </label>
        <textarea
          id={`${id}-images`}
          rows={3}
          value={images}
          onChange={(e) => setImages(e.target.value)}
          aria-describedby={`${id}-images-hint`}
          placeholder="https://example.com/shirt-front.jpg"
          className={inputClass}
        />
        <p id={`${id}-images-hint`} className="mt-1 text-sm text-muted">
          One https image link per line, up to {MAX_PRODUCT_IMAGES}. The first is the cover photo.
        </p>
      </div>
      {error ? (
        <p role="alert" className={notice.critical}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={`${primaryButton} min-h-11`}>
          {pending ? "Saving…" : product ? "Save changes" : "Create product"}
        </button>
        {product ? (
          <button type="button" className={`${secondaryButton} min-h-11`} onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function ProductRow({ product }: { product: PhysicalProductDto }) {
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [delta, setDelta] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge = STATUS_BADGE[product.status];
  const cover = product.imageUrls[0];

  async function run(request: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await request();
    setPending(false);
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  const changeStatus = (status: ProductStatus) =>
    run(() => requestJson(`/api/products/${product.id}`, { method: "PATCH", body: { status } }));

  function adjustStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const change = Number(delta);
    if (!Number.isInteger(change) || change === 0) {
      return setError("Enter a whole number of units to add, or a negative number to remove.");
    }
    void run(async () => {
      const result = await requestJson(`/api/products/${product.id}/stock`, { method: "POST", body: { delta: change } });
      if (result.ok) setDelta("");
      return result;
    });
  }

  return (
    <li className={card}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-surface">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
            <img src={cover} alt="" className="size-full object-cover" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">
              <Link href={`/products/${product.id}`} className="hover:underline">
                {product.name}
              </Link>
            </h3>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {product.stock === 0 ? <Badge tone="critical">Out of stock</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatDropsAsXrp(product.priceDrops)} XRP · {product.stock} in stock · {product.imageUrls.length}{" "}
            {product.imageUrls.length === 1 ? "photo" : "photos"}
          </p>
        </div>
      </div>

      {editing ? (
        <div className="mt-4 border-t border-border pt-4">
          <ProductForm product={product} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <button type="button" className={`${secondaryButton} min-h-11`} onClick={() => setEditing(true)}>
            Edit details<span className="sr-only"> of {product.name}</span>
          </button>
          {PRODUCT_STATUS_CHANGES[product.status].map((status) => (
            <button
              key={status}
              type="button"
              disabled={pending}
              className={`${status === "PUBLISHED" ? primaryButton : secondaryButton} min-h-11`}
              onClick={() => changeStatus(status)}
            >
              {statusAction(product.status, status)}
              <span className="sr-only"> {product.name}</span>
            </button>
          ))}
          <form onSubmit={adjustStock} className="flex items-end gap-2">
            <div>
              <label htmlFor={`${id}-delta`} className="block text-sm font-medium">
                Add or remove stock
              </label>
              <input
                id={`${id}-delta`}
                type="number"
                step={1}
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="e.g. 10 or -2"
                className="mt-1 min-h-11 w-36 rounded-lg border border-border bg-canvas px-3 py-2 text-base"
              />
            </div>
            <button type="submit" disabled={pending} className={`${secondaryButton} min-h-11`}>
              Apply
            </button>
          </form>
        </div>
      )}
      {error ? (
        <p role="alert" className={`${notice.critical} mt-3`}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function ProductManager({ products }: { products: PhysicalProductDto[] }) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby={`${headingId}-new`} className={`${card} max-w-2xl`}>
        <h2 id={`${headingId}-new`} className="text-lg font-semibold">
          Add a product
        </h2>
        <p className="mb-4 mt-1 text-sm text-muted">
          New products start as drafts. Publish one to show it on your storefront.
        </p>
        <ProductForm onDone={() => undefined} />
      </section>

      <section aria-labelledby={`${headingId}-list`}>
        <h2 id={`${headingId}-list`} className="mb-3 text-lg font-semibold">
          Your products
        </h2>
        {products.length === 0 ? (
          <EmptyState title="No products yet" description="Add your first product above." />
        ) : (
          <ul className="flex flex-col gap-3">
            {products.map((product) => (
              <ProductRow key={product.id} product={product} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
