"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { MAX_LINE_QUANTITY } from "@/contracts/commerce";
import { notice, primaryButton } from "@/features/wallet/styles";
import { addToCart } from "./cart-store";

/**
 * Adds a product to the cart (XRPL-066/067).
 *
 * When the product isn't on sale or has no stock there is no button to press at all, only the
 * reason. The server checks again when the order is placed, so this is a convenience, not the rule.
 */
export function AddToCart({
  productId,
  name,
  stock,
  onSale,
}: {
  productId: string;
  name: string;
  stock: number;
  /** False for a draft or archived product (only its seller can see the page then). */
  onSale: boolean;
}) {
  const id = useId();
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<"added" | "full" | null>(null);

  if (!onSale || stock <= 0) {
    return (
      <p role="status" className={notice.caution}>
        {onSale
          ? "Out of stock. This product can't be added to a cart right now."
          : "Not on sale. This product can't be added to a cart."}
      </p>
    );
  }

  const max = Math.min(stock, MAX_LINE_QUANTITY);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-quantity`} className="block text-sm font-medium">
            Quantity
          </label>
          <select
            id={`${id}-quantity`}
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
            className="mt-1 min-h-11 rounded-lg border border-border bg-canvas px-3 py-2 text-base"
          >
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={`${primaryButton} min-h-11`}
          onClick={() => setMessage(addToCart(productId, name, quantity) ? "added" : "full")}
        >
          Add to cart
        </button>
      </div>
      {message === "added" ? (
        <p role="status" className={notice.positive}>
          Added to your cart.{" "}
          <Link href="/cart" className="font-semibold underline">
            View cart
          </Link>
        </p>
      ) : null}
      {message === "full" ? (
        <p role="alert" className={notice.critical}>
          Your cart is full. Remove something before adding more.
        </p>
      ) : null}
    </div>
  );
}
