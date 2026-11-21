import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CartQuote } from "@/contracts/commerce";
import { CartView } from "./cart-view";
import { addToCart, readCart } from "./cart-store";

/** Cart review and simulated checkout (XRPL-067). */

const SHIRT = "11111111-1111-4111-8111-111111111111";
const POSTER = "22222222-2222-4222-8222-222222222222";
const SELLER = "33333333-3333-4333-8333-333333333333";

function quoteFor(items: { productId: string; quantity: number }[], outOfStock: string[] = []): CartQuote {
  const prices: Record<string, [name: string, drops: number]> = {
    [SHIRT]: ["Tour T-shirt", 15_000_000],
    [POSTER]: ["Poster", 4_000_000],
  };
  const lines = items.map(({ productId, quantity }) => {
    const [name, drops] = prices[productId] ?? ["Unknown", 1];
    const gone = outOfStock.includes(productId);
    return {
      productId,
      quantity,
      name,
      sellerId: SELLER,
      sellerName: "Night Market",
      imageUrl: null,
      unitPriceDrops: String(drops),
      lineTotalDrops: String(drops * quantity),
      stock: gone ? 0 : 5,
      problem: gone ? ("OUT_OF_STOCK" as const) : null,
    };
  });
  const subtotal = lines.filter((l) => !l.problem).reduce((sum, l) => sum + Number(l.lineTotalDrops), 0);
  return { lines, subtotalDrops: String(subtotal), canCheckout: lines.every((l) => !l.problem), payment: "SIMULATED" };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

let outOfStock: string[] = [];
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  if (url === "/api/cart/quote") return json(quoteFor(body.items, outOfStock));
  return json({ orders: [{ id: "order-1", sellerName: "Night Market", totalDrops: "34000000" }], payment: "SIMULATED" }, 201);
});

const ordersPosted = () => fetchMock.mock.calls.filter(([url]) => url === "/api/orders");

beforeEach(() => {
  window.localStorage.clear();
  outOfStock = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  addToCart(SHIRT, "Tour T-shirt", 2);
  addToCart(POSTER, "Poster", 1);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CartView", () => {
  it("shows the items and subtotal, says payment is simulated, and asks for no card details", async () => {
    render(<CartView signedIn />);

    expect(await screen.findByText("34 XRP")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tour T-shirt" })).toHaveAttribute("href", `/products/${SHIRT}`);
    expect(screen.getByText("30 XRP")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Simulated payment: no money moves/);
    expect(screen.getByRole("button", { name: "Place order (simulated payment)" })).toBeEnabled();
    // Delivery name and address are the only things checkout asks for.
    expect(screen.getAllByRole("textbox").map((el) => el.getAttribute("name"))).toEqual(["shippingName", "shippingAddress"]);
    expect(screen.queryByLabelText(/card|cvc|cvv|expiry/i)).not.toBeInTheDocument();
  });

  it("removes an item and re-quotes the subtotal", async () => {
    const user = userEvent.setup();
    render(<CartView signedIn />);
    await screen.findByText("34 XRP");

    await user.click(screen.getByRole("button", { name: "Remove Poster" }));

    expect(await screen.findByText("30 XRP", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Poster" })).not.toBeInTheDocument();
    expect(readCart()).toEqual([{ productId: SHIRT, name: "Tour T-shirt", quantity: 2 }]);
  });

  it("places the order with items and delivery details only, then empties the cart", async () => {
    const user = userEvent.setup();
    render(<CartView signedIn />);
    await screen.findByText("34 XRP");

    // Nothing is sent until the delivery details are filled in.
    await user.click(screen.getByRole("button", { name: "Place order (simulated payment)" }));
    expect(screen.getByText("Enter a delivery address")).toBeInTheDocument();
    expect(ordersPosted()).toHaveLength(0);

    await user.type(screen.getByLabelText("Deliver to (name)"), "Aoife Murphy");
    await user.type(screen.getByLabelText("Delivery address"), "1 Main Street, Dublin");
    await user.click(screen.getByRole("button", { name: "Place order (simulated payment)" }));

    expect(await screen.findByText("Order placed")).toBeInTheDocument();
    expect(screen.getByText(/no money moved/)).toBeInTheDocument();
    const [[, init]] = ordersPosted() as [[string, RequestInit]];
    expect(JSON.parse(String(init.body))).toEqual({
      items: [
        { productId: SHIRT, quantity: 2 },
        { productId: POSTER, quantity: 1 },
      ],
      shippingName: "Aoife Murphy",
      shippingAddress: "1 Main Street, Dublin",
    });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    await waitFor(() => expect(readCart()).toEqual([]));
  });

  it("blocks checkout while an item is out of stock, and when signed out", async () => {
    outOfStock = [POSTER];
    const { unmount } = render(<CartView signedIn />);

    expect(await screen.findByText(/Out of stock\. Remove it to check out\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Place order (simulated payment)" })).toBeDisabled();
    unmount();

    render(<CartView signedIn={false} />);
    expect(await screen.findByRole("link", { name: "Sign in to check out" })).toHaveAttribute("href", "/onboarding");
    expect(screen.queryByRole("button", { name: /Place order/ })).not.toBeInTheDocument();
  });
});
