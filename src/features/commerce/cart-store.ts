import { MAX_CART_LINES, MAX_LINE_QUANTITY } from "@/contracts/commerce";

/**
 * The merchandise cart (XRPL-067). It lives in this browser's localStorage and holds only product
 * ids, quantities and the name shown when the item was added. No prices (the server quotes them),
 * no address and no payment details are kept here.
 */

export type CartItem = { productId: string; quantity: number; name: string };

const STORAGE_KEY = "xt.merch.cart.v1";
/** Fired on `window` after every change, so open cart views stay in step. */
const CART_CHANGED_EVENT = "xt:merch-cart-changed";

const clampQuantity = (quantity: number) => Math.max(1, Math.min(MAX_LINE_QUANTITY, Math.trunc(quantity)));

function isCartItem(value: unknown): value is CartItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.productId === "string" && typeof item.name === "string" && Number.isInteger(item.quantity);
}

/** The stored cart as text: a stable snapshot for `useSyncExternalStore`. */
export function readCartRaw(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Parses stored cart text, dropping anything that isn't a usable line. */
export function parseCart(raw: string): CartItem[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(isCartItem)
      .slice(0, MAX_CART_LINES)
      .map((item) => ({ productId: item.productId, name: item.name, quantity: clampQuantity(item.quantity) }));
  } catch {
    return [];
  }
}

export const readCart = (): CartItem[] => parseCart(readCartRaw());

/** Calls `onChange` when the cart changes in this tab or another one. Returns the unsubscribe. */
export function subscribeCart(onChange: () => void): () => void {
  window.addEventListener(CART_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CART_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeCart(items: CartItem[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or blocked: nothing is saved, and the cart view keeps showing what is stored.
  }
  window.dispatchEvent(new Event(CART_CHANGED_EVENT));
}

/** Adds units of a product, merging with a line already in the cart. False when the cart is full. */
export function addToCart(productId: string, name: string, quantity: number): boolean {
  const items = readCart();
  const existing = items.find((item) => item.productId === productId);
  if (existing) {
    existing.quantity = clampQuantity(existing.quantity + quantity);
    existing.name = name;
  } else {
    if (items.length >= MAX_CART_LINES) return false;
    items.push({ productId, name, quantity: clampQuantity(quantity) });
  }
  writeCart(items);
  return true;
}

export function setCartQuantity(productId: string, quantity: number): void {
  writeCart(
    readCart().map((item) => (item.productId === productId ? { ...item, quantity: clampQuantity(quantity) } : item)),
  );
}

export function removeFromCart(productId: string): void {
  writeCart(readCart().filter((item) => item.productId !== productId));
}

export function clearCart(): void {
  writeCart([]);
}
