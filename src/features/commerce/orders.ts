import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  CartQuoteRequest,
  CommerceErrorCode,
  MERCH_ORDER_STATUS_CHANGES,
  PlaceOrderRequest,
  UpdateOrderStatusRequest,
  type CartQuote,
  type CartQuoteLine,
  type MerchOrderDto,
} from "@/contracts/commerce";
import type { AuthSession } from "@/lib/auth/session";
import { AppError, errors } from "@/lib/http/response";

/**
 * Merchandise cart quotes and orders (XRPL-067 to 069), enforced on the server for every caller:
 *  - prices and names are read from the database when the order is placed, never from the request;
 *  - placing an order takes its units out of stock in the same transaction that creates it, behind
 *    row locks on the products, so stock is decremented exactly once and never oversold;
 *  - a cart with several sellers' products becomes one order per seller, all or nothing;
 *  - only the seller changes an order's status, along MERCH_ORDER_STATUS_CHANGES;
 *  - cancelling returns the order's units to stock, once;
 *  - an order can be read only by its buyer and its seller. Everyone else gets 404.
 * Payment is simulated: no money moves and no payment details are accepted or stored.
 */

const ORDER_INCLUDE = {
  items: { orderBy: [{ productName: "asc" }, { id: "asc" }] },
  buyer: { select: { displayName: true } },
  seller: { select: { displayName: true } },
} satisfies Prisma.MerchOrderInclude;

type OrderRow = Prisma.MerchOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

const lineTotal = (unitPriceDrops: string, quantity: number) => BigInt(unitPriceDrops) * BigInt(quantity);

export function toOrderDto(order: OrderRow): MerchOrderDto {
  return {
    id: order.id,
    buyerId: order.buyerId,
    buyerName: order.buyer.displayName,
    sellerId: order.sellerId,
    sellerName: order.seller.displayName,
    status: order.status,
    items: order.items.map((item) => ({
      productId: item.productId,
      name: item.productName,
      unitPriceDrops: item.unitPriceDrops,
      quantity: item.quantity,
      lineTotalDrops: lineTotal(item.unitPriceDrops, item.quantity).toString(),
    })),
    totalDrops: order.totalDrops,
    shippingName: order.shippingName,
    shippingAddress: order.shippingAddress,
    payment: "SIMULATED",
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

/**
 * Current names, prices and availability for a cart. Reads only published products, so a line for
 * anything else comes back as UNAVAILABLE with no details. Changes nothing and reserves nothing.
 */
export async function quoteCart(db: Pick<PrismaClient, "physicalProduct">, input: unknown): Promise<CartQuote> {
  const { items } = CartQuoteRequest.parse(input);
  const products = await db.physicalProduct.findMany({
    where: { id: { in: items.map((i) => i.productId) }, status: "PUBLISHED" },
    select: {
      id: true,
      name: true,
      sellerId: true,
      priceDrops: true,
      imageUrls: true,
      stock: true,
      seller: { select: { displayName: true } },
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  let subtotal = 0n;
  const lines: CartQuoteLine[] = items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) {
      return {
        productId: item.productId,
        quantity: item.quantity,
        name: null,
        sellerId: null,
        sellerName: null,
        imageUrl: null,
        unitPriceDrops: null,
        lineTotalDrops: null,
        stock: null,
        problem: "UNAVAILABLE",
      };
    }
    const problem =
      product.stock === 0 ? "OUT_OF_STOCK" : product.stock < item.quantity ? "INSUFFICIENT_STOCK" : null;
    const total = lineTotal(product.priceDrops, item.quantity);
    if (!problem) subtotal += total;
    return {
      productId: product.id,
      quantity: item.quantity,
      name: product.name,
      sellerId: product.sellerId,
      sellerName: product.seller.displayName,
      imageUrl: product.imageUrls[0] ?? null,
      unitPriceDrops: product.priceDrops,
      lineTotalDrops: total.toString(),
      stock: product.stock,
      problem,
    };
  });

  return {
    lines,
    subtotalDrops: subtotal.toString(),
    canCheckout: lines.every((line) => line.problem === null),
    payment: "SIMULATED",
  };
}

type LockedProduct = {
  id: string;
  sellerId: string;
  name: string;
  priceDrops: string;
  stock: number;
  status: string;
};

/**
 * Places the signed-in customer's order: one order per seller in the cart, or nothing at all.
 *
 * The products are locked (`FOR UPDATE`, always in id order so two checkouts queue instead of
 * deadlocking), checked, and decremented in the same transaction that creates the orders. A second
 * checkout for the last unit waits for the first, then sees no stock and gets 409.
 * A retried request is deduplicated by the route's Idempotency-Key, not here.
 */
export async function placeOrder(db: PrismaClient, session: AuthSession, input: unknown): Promise<MerchOrderDto[]> {
  const data = PlaceOrderRequest.parse(input);
  const items = [...data.items].sort((a, b) => (a.productId < b.productId ? -1 : 1));

  const orders = await db.$transaction(async (tx) => {
    const ids = Prisma.join(items.map((item) => Prisma.sql`${item.productId}::uuid`));
    const locked = await tx.$queryRaw<LockedProduct[]>`
      SELECT "id", "sellerId", "name", "priceDrops", "stock", "status"::text AS "status"
      FROM "PhysicalProduct"
      WHERE "id" IN (${ids})
      ORDER BY "id"
      FOR UPDATE`;
    const byId = new Map(locked.map((p) => [p.id, p]));

    // Check every line before changing anything, so a refused order leaves stock untouched.
    const bySeller = new Map<string, { product: LockedProduct; quantity: number }[]>();
    for (const item of items) {
      const product = byId.get(item.productId);
      if (!product || product.status !== "PUBLISHED") {
        throw new AppError(
          CommerceErrorCode.PRODUCT_UNAVAILABLE,
          "A product in your cart is no longer available. Remove it and try again.",
          409,
          { productId: item.productId },
        );
      }
      if (product.stock < item.quantity) {
        throw new AppError(
          CommerceErrorCode.INSUFFICIENT_STOCK,
          product.stock === 0
            ? `${product.name} is out of stock.`
            : `Only ${product.stock} of ${product.name} left in stock.`,
          409,
          { productId: product.id, stock: product.stock, requested: item.quantity },
        );
      }
      bySeller.set(product.sellerId, [...(bySeller.get(product.sellerId) ?? []), { product, quantity: item.quantity }]);
    }

    for (const item of items) {
      await tx.physicalProduct.update({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
      });
    }

    const created: OrderRow[] = [];
    for (const [sellerId, lines] of [...bySeller.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const total = lines.reduce((sum, l) => sum + lineTotal(l.product.priceDrops, l.quantity), 0n);
      created.push(
        await tx.merchOrder.create({
          data: {
            buyerId: session.userId,
            sellerId,
            totalDrops: total.toString(),
            shippingName: data.shippingName,
            shippingAddress: data.shippingAddress,
            items: {
              create: lines.map((l) => ({
                productId: l.product.id,
                productName: l.product.name,
                unitPriceDrops: l.product.priceDrops,
                quantity: l.quantity,
              })),
            },
          },
          include: ORDER_INCLUDE,
        }),
      );
    }
    return created;
  });

  return orders.map(toOrderDto);
}

/** The signed-in customer's orders, newest first. */
export async function listMyOrders(db: Pick<PrismaClient, "merchOrder">, session: AuthSession): Promise<MerchOrderDto[]> {
  const rows = await db.merchOrder.findMany({
    where: { buyerId: session.userId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: ORDER_INCLUDE,
  });
  return rows.map(toOrderDto);
}

/** Orders placed with the signed-in seller, newest first. */
export async function listSellerOrders(
  db: Pick<PrismaClient, "merchOrder">,
  session: AuthSession,
): Promise<MerchOrderDto[]> {
  const rows = await db.merchOrder.findMany({
    where: { sellerId: session.userId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: ORDER_INCLUDE,
  });
  return rows.map(toOrderDto);
}

const isParty = (order: { buyerId: string; sellerId: string }, session: AuthSession) =>
  order.buyerId === session.userId || order.sellerId === session.userId;

/** One order, for its buyer or its seller. 404 for anyone else, so order ids reveal nothing. */
export async function getOrder(
  db: Pick<PrismaClient, "merchOrder">,
  session: AuthSession,
  orderId: string,
): Promise<MerchOrderDto> {
  const order = await db.merchOrder.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order || !isParty(order, session)) throw errors.notFound("Order not found");
  return toOrderDto(order);
}

/**
 * The seller moves an order along MERCH_ORDER_STATUS_CHANGES. Cancelling returns every item's
 * units to stock in the same transaction. The order row is locked first, so two changes arriving
 * together apply one after the other and a repeated cancel can't restock twice. Asking for the
 * status the order already has changes nothing.
 */
export async function updateOrderStatus(
  db: PrismaClient,
  session: AuthSession,
  orderId: string,
  input: unknown,
): Promise<MerchOrderDto> {
  const { status: next } = UpdateOrderStatusRequest.parse(input);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MerchOrder" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.merchOrder.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order || !isParty(order, session)) throw errors.notFound("Order not found");
    if (order.sellerId !== session.userId) {
      throw new AppError(CommerceErrorCode.ORDER_NOT_SELLER, "Only the seller can change an order's status.", 403);
    }
    if (order.status === next) return toOrderDto(order);
    if (!MERCH_ORDER_STATUS_CHANGES[order.status].includes(next)) {
      throw new AppError(
        CommerceErrorCode.INVALID_STATUS_CHANGE,
        `A ${order.status.toLowerCase()} order can't be changed to ${next.toLowerCase()}.`,
        409,
        { from: order.status, to: next },
      );
    }

    const restock = next === "CANCELLED" && order.restockedAt === null;
    if (restock) {
      const items = [...order.items].sort((a, b) => (a.productId < b.productId ? -1 : 1));
      for (const item of items) {
        await tx.physicalProduct.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }
    }

    const updated = await tx.merchOrder.update({
      where: { id: order.id },
      data: { status: next, ...(restock ? { restockedAt: new Date() } : {}) },
      include: ORDER_INCLUDE,
    });
    return toOrderDto(updated);
  });
}
