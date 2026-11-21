import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postOrder } from "@/app/api/orders/route";
import type { UserRole } from "@/contracts";
import { createSession, type AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getOrder, listMyOrders, listSellerOrders, placeOrder, quoteCart, updateOrderStatus } from "./orders";

/** Merchandise orders against Postgres (XRPL-067 to 069, `npm run test:db`). */

const db = getDb();

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "MerchOrderItem","MerchOrder","PhysicalProduct","Session","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function account(displayName: string, role: UserRole = "CUSTOMER"): Promise<AuthSession> {
  const user = await db.user.create({ data: { displayName, role, onboardedAt: new Date() } });
  return {
    sessionId: "s",
    userId: user.id,
    displayName,
    role,
    onboardedAt: user.onboardedAt,
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: null,
    walletVerifiedAt: null,
  };
}

function product(sellerId: string, over: { name?: string; priceDrops?: string; stock?: number; draft?: boolean } = {}) {
  return db.physicalProduct.create({
    data: {
      sellerId,
      name: over.name ?? "Tour T-shirt",
      priceDrops: over.priceDrops ?? "15000000",
      stock: over.stock ?? 3,
      status: over.draft ? "DRAFT" : "PUBLISHED",
      publishedAt: over.draft ? null : new Date(),
    },
  });
}

const cart = (...items: [productId: string, quantity: number][]) => ({
  items: items.map(([productId, quantity]) => ({ productId, quantity })),
  shippingName: "Aoife Murphy",
  shippingAddress: "1 Main Street, Dublin",
});

const stockOf = async (id: string) => (await db.physicalProduct.findUniqueOrThrow({ where: { id } })).stock;

/** Places an order for one seller's products and returns that single order. */
async function placeOne(buyer: AuthSession, body: ReturnType<typeof cart>) {
  const [order] = await placeOrder(db, buyer, body);
  if (!order) throw new Error("expected one order");
  return order;
}

describe("placing an order", () => {
  it("takes the units out of stock and makes one order per seller, with name and price copied", async () => {
    const [buyer, sellerA, sellerB] = [await account("Aoife"), await account("Night Market", "SELLER"), await account("Vinyl Den", "SELLER")];
    const shirt = await product(sellerA.userId, { stock: 5 });
    const poster = await product(sellerA.userId, { name: "Poster", priceDrops: "4000000", stock: 2 });
    const record = await product(sellerB.userId, { name: "Record", priceDrops: "30000000", stock: 1 });

    const quote = await quoteCart(db, { items: cart([shirt.id, 2], [poster.id, 1], [record.id, 1]).items });
    expect(quote).toMatchObject({ subtotalDrops: "64000000", canCheckout: true, payment: "SIMULATED" });

    const orders = await placeOrder(db, buyer, cart([shirt.id, 2], [poster.id, 1], [record.id, 1]));

    expect(orders).toHaveLength(2);
    const forA = orders.find((o) => o.sellerId === sellerA.userId)!;
    const forB = orders.find((o) => o.sellerId === sellerB.userId)!;
    expect(forA).toMatchObject({ status: "NEW", totalDrops: "34000000", buyerId: buyer.userId, payment: "SIMULATED" });
    expect(forA.items).toEqual([
      { productId: poster.id, name: "Poster", unitPriceDrops: "4000000", quantity: 1, lineTotalDrops: "4000000" },
      { productId: shirt.id, name: "Tour T-shirt", unitPriceDrops: "15000000", quantity: 2, lineTotalDrops: "30000000" },
    ]);
    expect(forB.totalDrops).toBe("30000000");
    expect([await stockOf(shirt.id), await stockOf(poster.id), await stockOf(record.id)]).toEqual([3, 1, 0]);

    // A later edit to the product never rewrites a past order.
    await db.physicalProduct.update({ where: { id: shirt.id }, data: { name: "Renamed", priceDrops: "99000000" } });
    const again = await getOrder(db, buyer, forA.id);
    expect(again.items[1]).toMatchObject({ name: "Tour T-shirt", unitPriceDrops: "15000000" });
    expect(again.totalDrops).toBe("34000000");
  });

  it("sells the last unit once when two customers order it at the same moment", async () => {
    const [first, second, seller] = [await account("Aoife"), await account("Brian"), await account("Night Market", "SELLER")];
    const shirt = await product(seller.userId, { stock: 1 });

    const results = await Promise.allSettled([
      placeOrder(db, first, cart([shirt.id, 1])),
      placeOrder(db, second, cart([shirt.id, 1])),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
    expect(await stockOf(shirt.id)).toBe(0);
    expect(await db.merchOrder.count()).toBe(1);
  });

  it("refuses the whole order and leaves stock alone when one line can't be met", async () => {
    const [buyer, seller] = [await account("Aoife"), await account("Night Market", "SELLER")];
    const shirt = await product(seller.userId, { stock: 3 });
    const draft = await product(seller.userId, { name: "Unreleased", draft: true });

    await expect(placeOrder(db, buyer, cart([shirt.id, 1], [draft.id, 1]))).rejects.toMatchObject({
      code: "PRODUCT_UNAVAILABLE",
      status: 409,
    });
    await expect(placeOrder(db, buyer, cart([shirt.id, 4]))).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      details: { stock: 3, requested: 4 },
    });
    expect(await stockOf(shirt.id)).toBe(3);
    expect(await db.merchOrder.count()).toBe(0);

    // The quote says the same without revealing anything about the draft.
    const quote = await quoteCart(db, { items: cart([shirt.id, 4], [draft.id, 1]).items });
    expect(quote.canCheckout).toBe(false);
    expect(quote.lines.map((l) => [l.problem, l.name])).toEqual([
      ["INSUFFICIENT_STOCK", "Tour T-shirt"],
      ["UNAVAILABLE", null],
    ]);
  });
});

describe("POST /api/orders", () => {
  async function request(buyer: AuthSession, body: unknown, key: string | null) {
    const { token } = await createSession(db, buyer.userId, "ONBOARDING");
    return postOrder(
      new Request("http://localhost:3000/api/orders", {
        method: "POST",
        headers: {
          cookie: `xt_session=${token}`,
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      }),
      {},
    );
  }

  it("replays a repeated request instead of ordering and decrementing stock twice", async () => {
    const [buyer, seller] = [await account("Aoife"), await account("Night Market", "SELLER")];
    const shirt = await product(seller.userId, { stock: 3 });

    const first = await request(buyer, cart([shirt.id, 2]), "checkout-key-0001");
    const second = await request(buyer, cart([shirt.id, 2]), "checkout-key-0001");

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    const [a, b] = [await first.json(), await second.json()];
    expect(a.data.payment).toBe("SIMULATED");
    expect(b.data.orders[0].id).toBe(a.data.orders[0].id);
    expect(await stockOf(shirt.id)).toBe(1);
    expect(await db.merchOrder.count()).toBe(1);
  });

  it("needs a session and a key, and rejects card details instead of storing them", async () => {
    const [buyer, seller] = [await account("Aoife"), await account("Night Market", "SELLER")];
    const shirt = await product(seller.userId);

    expect((await request(buyer, cart([shirt.id, 1]), null)).status).toBe(400);
    const withCard = await request(buyer, { ...cart([shirt.id, 1]), cardNumber: "4242424242424242" }, "checkout-key-0002");
    expect(withCard.status).toBe(400);
    const anonymous = await postOrder(
      new Request("http://localhost:3000/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "checkout-key-0003" },
        body: JSON.stringify(cart([shirt.id, 1])),
      }),
      {},
    );
    expect(anonymous.status).toBe(401);
    expect(await stockOf(shirt.id)).toBe(3);
    expect(await db.merchOrder.count()).toBe(0);
  });
});

describe("order status", () => {
  it("follows the state machine, only for the seller, and cancelling restocks once", async () => {
    const [buyer, seller, stranger] = [await account("Aoife"), await account("Night Market", "SELLER"), await account("Vinyl Den", "SELLER")];
    const shirt = await product(seller.userId, { stock: 3 });
    const order = await placeOne(buyer, cart([shirt.id, 2]));
    expect(await stockOf(shirt.id)).toBe(1);

    await expect(updateOrderStatus(db, buyer, order.id, { status: "CANCELLED" })).rejects.toMatchObject({
      code: "ORDER_NOT_SELLER",
      status: 403,
    });
    await expect(updateOrderStatus(db, stranger, order.id, { status: "PROCESSING" })).rejects.toMatchObject({ status: 404 });
    await expect(updateOrderStatus(db, seller, order.id, { status: "SHIPPED" })).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
      status: 409,
    });

    expect((await updateOrderStatus(db, seller, order.id, { status: "PROCESSING" })).status).toBe("PROCESSING");
    expect(await stockOf(shirt.id)).toBe(1);

    expect((await updateOrderStatus(db, seller, order.id, { status: "CANCELLED" })).status).toBe("CANCELLED");
    expect(await stockOf(shirt.id)).toBe(3);
    // Cancelling again changes nothing: the units went back once.
    await updateOrderStatus(db, seller, order.id, { status: "CANCELLED" });
    expect(await stockOf(shirt.id)).toBe(3);
    await expect(updateOrderStatus(db, seller, order.id, { status: "PROCESSING" })).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
    });
  });

  it("goes new, processing, shipped, fulfilled, and can't be cancelled once shipped", async () => {
    const [buyer, seller] = [await account("Aoife"), await account("Night Market", "SELLER")];
    const shirt = await product(seller.userId, { stock: 3 });
    const order = await placeOne(buyer, cart([shirt.id, 1]));

    for (const status of ["PROCESSING", "SHIPPED"] as const) {
      expect((await updateOrderStatus(db, seller, order.id, { status })).status).toBe(status);
    }
    await expect(updateOrderStatus(db, seller, order.id, { status: "CANCELLED" })).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
    });
    expect((await updateOrderStatus(db, seller, order.id, { status: "FULFILLED" })).status).toBe("FULFILLED");
    expect(await stockOf(shirt.id)).toBe(2);
  });
});

describe("who can read an order", () => {
  it("is the purchaser and the seller; everyone else gets 404", async () => {
    const [buyer, otherBuyer, seller, otherSeller] = [
      await account("Aoife"),
      await account("Brian"),
      await account("Night Market", "SELLER"),
      await account("Vinyl Den", "SELLER"),
    ];
    const shirt = await product(seller.userId);
    const order = await placeOne(buyer, cart([shirt.id, 1]));

    expect((await getOrder(db, buyer, order.id)).id).toBe(order.id);
    expect((await getOrder(db, seller, order.id)).shippingAddress).toBe("1 Main Street, Dublin");
    await expect(getOrder(db, otherBuyer, order.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(getOrder(db, otherSeller, order.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    expect((await listMyOrders(db, buyer)).map((o) => o.id)).toEqual([order.id]);
    expect(await listMyOrders(db, otherBuyer)).toEqual([]);
    expect(await listMyOrders(db, seller)).toEqual([]);
    expect((await listSellerOrders(db, seller)).map((o) => o.id)).toEqual([order.id]);
    expect(await listSellerOrders(db, otherSeller)).toEqual([]);
  });
});
