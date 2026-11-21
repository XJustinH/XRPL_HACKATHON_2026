"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  MAX_LINE_QUANTITY,
  PHYSICAL_MERCH_LABEL,
  PlaceOrderRequest,
  SIMULATED_PAYMENT_NOTICE,
  type CartLineProblem,
  type CartQuote,
  type MerchOrderDto,
  type PlaceOrderResult,
} from "@/contracts/commerce";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { formatDropsAsXrp } from "@/lib/xrpl/format";
import { clearCart, parseCart, readCartRaw, removeFromCart, setCartQuantity, subscribeCart } from "./cart-store";

/**
 * Cart review and checkout (XRPL-067).
 *
 * The cart holds product ids and quantities only. Names, prices, availability and the subtotal come
 * from the server's quote, and the server prices the order again when it is placed. Checkout asks
 * for a delivery name and address and nothing else: payment is simulated, so there are no card
 * fields to fill in and nothing about a payment is sent or stored.
 */

const PROBLEM_TEXT: Record<CartLineProblem, string> = {
  UNAVAILABLE: "No longer available. Remove it to check out.",
  OUT_OF_STOCK: "Out of stock. Remove it to check out.",
  INSUFFICIENT_STOCK: "Not enough in stock. Lower the quantity to check out.",
};

const xrp = (drops: string) => `${formatDropsAsXrp(drops)} XRP`;

type Envelope<T> = { ok: true; data: T } | { ok: false; message: string };

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Envelope<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
    if (response.ok && payload?.data !== undefined) return { ok: true, data: payload.data };
    return { ok: false, message: payload?.error?.message ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

/** A key for one checkout attempt: letters, digits and dashes, as the server requires. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `order-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function CartView({ signedIn, defaultName = "" }: { signedIn: boolean; defaultName?: string }) {
  const formId = useId();
  // Null on the server and during hydration: the cart exists only in this browser.
  const raw = useSyncExternalStore<string | null>(subscribeCart, readCartRaw, () => null);
  const items = useMemo(() => (raw === null ? null : parseCart(raw)), [raw]);

  const [quoted, setQuoted] = useState<{ raw: string; result: Envelope<CartQuote> } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [shippingName, setShippingName] = useState(defaultName);
  const [shippingAddress, setShippingAddress] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ shippingName?: string; shippingAddress?: string }>({});
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<MerchOrderDto[] | null>(null);
  /** One Idempotency-Key per distinct order, so a retry replays instead of ordering twice. */
  const attempt = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (raw === null) return;
    const lines = parseCart(raw).map(({ productId, quantity }) => ({ productId, quantity }));
    if (lines.length === 0) return;
    let cancelled = false;
    void postJson<CartQuote>("/api/cart/quote", { items: lines }).then((result) => {
      if (!cancelled) setQuoted({ raw, result });
    });
    return () => {
      cancelled = true;
    };
  }, [raw, refresh]);

  if (placed) {
    return (
      <div className={card} role="status">
        <h2 className="text-lg font-semibold">Order placed</h2>
        <p className="mt-2 text-sm">
          Payment was simulated: no money moved and no payment details were taken.
          {placed.length > 1 ? ` Your cart had items from ${placed.length} sellers, so it became ${placed.length} orders.` : ""}
        </p>
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          {placed.map((order) => (
            <li key={order.id}>
              <Link href={`/orders/${order.id}`} className="font-medium text-accent underline">
                Order from {order.sellerName}: {xrp(order.totalDrops)}
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/orders" className={`${secondaryButton} mt-5`}>
          View your orders
        </Link>
      </div>
    );
  }

  if (items === null) {
    return <p className="text-sm text-muted">Loading your cart…</p>;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        description="Add merchandise from a seller's page. Tickets and digital collectibles are bought on their own pages."
        action={
          <Link href="/" className={primaryButton}>
            Browse events and sellers
          </Link>
        }
      />
    );
  }

  const current = quoted && quoted.raw === raw ? quoted.result : null;
  const quote = current?.ok ? current.data : null;
  const quoteError = current && !current.ok ? current.message : null;
  const lineFor = (productId: string) => quote?.lines.find((line) => line.productId === productId) ?? null;

  async function placeOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (placing || !items || !quote?.canCheckout) return;
    setError(null);

    const parsed = PlaceOrderRequest.safeParse({
      items: items.map(({ productId, quantity }) => ({ productId, quantity })),
      shippingName,
      shippingAddress,
    });
    if (!parsed.success) {
      const next: typeof fieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "shippingName" || field === "shippingAddress") next[field] ??= issue.message;
      }
      setFieldErrors(next);
      if (Object.keys(next).length === 0) setError("Your cart couldn't be checked out. Refresh and try again.");
      return;
    }
    setFieldErrors({});

    const body = JSON.stringify(parsed.data);
    if (attempt.current?.body !== body) attempt.current = { body, key: newIdempotencyKey() };

    setPlacing(true);
    const result = await postJson<PlaceOrderResult>("/api/orders", parsed.data, {
      "Idempotency-Key": attempt.current.key,
    });
    setPlacing(false);

    if (!result.ok) {
      setError(result.message);
      // Stock or availability may have changed under the cart: show the current state.
      setRefresh((n) => n + 1);
      return;
    }
    attempt.current = null;
    setPlaced(result.data.orders);
    clearCart();
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section aria-labelledby={`${formId}-items`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id={`${formId}-items`} className="text-lg font-semibold">
            Items
          </h2>
          <Badge>{PHYSICAL_MERCH_LABEL}</Badge>
        </div>
        {quoteError ? (
          <p role="alert" className={`${notice.critical} mb-3`}>
            Prices couldn&apos;t be loaded: {quoteError}
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const line = lineFor(item.productId);
            const name = line?.name ?? item.name;
            const maxQuantity = Math.max(item.quantity, Math.min(line?.stock ?? MAX_LINE_QUANTITY, MAX_LINE_QUANTITY));
            return (
              <li key={item.productId} className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {line && line.problem !== "UNAVAILABLE" ? (
                        <Link href={`/products/${item.productId}`} className="hover:underline">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </p>
                    {line?.sellerName ? <p className="text-sm text-muted">Sold by {line.sellerName}</p> : null}
                    {line?.unitPriceDrops ? (
                      <p className="mt-1 text-sm text-muted">{xrp(line.unitPriceDrops)} each</p>
                    ) : null}
                  </div>
                  <p className="shrink-0 text-base font-semibold">
                    {line?.lineTotalDrops ? xrp(line.lineTotalDrops) : "—"}
                  </p>
                </div>
                {line?.problem ? (
                  <p role="alert" className={`${notice.caution} mt-3`}>
                    {PROBLEM_TEXT[line.problem]}
                    {line.problem === "INSUFFICIENT_STOCK" && line.stock !== null ? ` Only ${line.stock} left.` : ""}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <span>Quantity</span>
                    <select
                      aria-label={`Quantity of ${name}`}
                      value={item.quantity}
                      onChange={(event) => setCartQuantity(item.productId, Number(event.target.value))}
                      className="min-h-11 rounded-lg border border-border bg-canvas px-3 py-2 text-base"
                    >
                      {Array.from({ length: maxQuantity }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    className={`${secondaryButton} min-h-11`}
                    onClick={() => removeFromCart(item.productId)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby={`${formId}-checkout`} className={`${card} h-fit`}>
        <h2 id={`${formId}-checkout`} className="text-lg font-semibold">
          Checkout
        </h2>
        <dl className="mt-3 flex items-center justify-between text-sm">
          <dt className="text-muted">Subtotal</dt>
          <dd className="text-base font-semibold">{quote ? xrp(quote.subtotalDrops) : "…"}</dd>
        </dl>
        <p role="note" className={`${notice.caution} mt-4`}>
          {SIMULATED_PAYMENT_NOTICE}
        </p>

        {signedIn ? (
          <form noValidate onSubmit={placeOrder} className="mt-4 flex flex-col gap-4">
            <div>
              <label htmlFor={`${formId}-name`} className="block text-sm font-medium">
                Deliver to (name)
              </label>
              <input
                id={`${formId}-name`}
                name="shippingName"
                autoComplete="name"
                value={shippingName}
                onChange={(event) => setShippingName(event.target.value)}
                aria-invalid={fieldErrors.shippingName ? true : undefined}
                aria-describedby={fieldErrors.shippingName ? `${formId}-name-error` : undefined}
                className={inputClass}
              />
              {fieldErrors.shippingName ? (
                <p id={`${formId}-name-error`} className="mt-1 text-sm text-critical">
                  {fieldErrors.shippingName}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor={`${formId}-address`} className="block text-sm font-medium">
                Delivery address
              </label>
              <textarea
                id={`${formId}-address`}
                name="shippingAddress"
                autoComplete="street-address"
                rows={3}
                value={shippingAddress}
                onChange={(event) => setShippingAddress(event.target.value)}
                aria-invalid={fieldErrors.shippingAddress ? true : undefined}
                aria-describedby={fieldErrors.shippingAddress ? `${formId}-address-error` : undefined}
                className={inputClass}
              />
              {fieldErrors.shippingAddress ? (
                <p id={`${formId}-address-error`} className="mt-1 text-sm text-critical">
                  {fieldErrors.shippingAddress}
                </p>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className={notice.critical}>
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={placing || !quote?.canCheckout} className={`${primaryButton} min-h-11`}>
              {placing ? "Placing order…" : "Place order (simulated payment)"}
            </button>
            {quote && !quote.canCheckout ? (
              <p className="text-sm text-muted">Fix the items marked above to check out.</p>
            ) : null}
          </form>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-muted">Sign in to place this order. Your cart is kept in this browser.</p>
            <Link href="/onboarding" className={`${primaryButton} mt-3`}>
              Sign in to check out
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
