import { z } from "zod";
import { AppId, Drops, IsoDateTime } from "./common";

/**
 * Physical merchandise (XRPL-064). Commerce slice of the shared contracts.
 *
 * Products are ordinary goods, stored and served separately from ticket NFTs and NFT offers:
 * nothing about a product lives on the ledger, and no product field is an XRPL identifier.
 * Prices are integer drops of Testnet XRP, like every other amount in the app. Real-money
 * payment is deferred for the hackathon (docs/architecture.md §7).
 */

/** Error codes specific to this slice (cross-cutting codes live in common.ts). */
export const CommerceErrorCode = {
  /** 403: only the product's own seller can change it. */
  PRODUCT_NOT_OWNED: "PRODUCT_NOT_OWNED",
  /** 403: a product can only be linked to one of the seller's own events. */
  PRODUCT_EVENT_NOT_OWNED: "PRODUCT_EVENT_NOT_OWNED",
  /** 409: the stock change would take stock below zero. */
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  /** 409: the requested status change isn't allowed from the current status. */
  INVALID_STATUS_CHANGE: "INVALID_STATUS_CHANGE",
  /** 409: a product in the order isn't on sale (unpublished, archived or removed). */
  PRODUCT_UNAVAILABLE: "PRODUCT_UNAVAILABLE",
  /** 403: only the order's seller can change its status. */
  ORDER_NOT_SELLER: "ORDER_NOT_SELLER",
} as const;
export type CommerceErrorCode = (typeof CommerceErrorCode)[keyof typeof CommerceErrorCode];

/**
 * DRAFT: visible to its seller only. PUBLISHED: on the storefront. ARCHIVED: withdrawn but kept,
 * so past orders still refer to it.
 */
export const ProductStatus = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export type ProductStatus = z.infer<typeof ProductStatus>;

/** Allowed status changes. Archived products go back to draft before they can be republished. */
export const PRODUCT_STATUS_CHANGES: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["DRAFT", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

export const MAX_PRODUCT_IMAGES = 6;
/** Upper bound for stock and for a single stock adjustment. */
export const MAX_PRODUCT_STOCK = 100_000;

export const ProductName = z.string().trim().min(2, "Name must be at least 2 characters").max(120);
export const ProductDescription = z.string().trim().max(4_000);
/** A price above zero, in integer drops (1 XRP = 1,000,000 drops). */
export const ProductPriceDrops = Drops.refine((v) => v !== "0", "Price must be more than 0");
/** https only: images are shown to every visitor, so no plain-http or script URLs. */
export const ProductImageUrl = z.url({ protocol: /^https$/, error: "Image must be an https URL" }).max(2_048);
export const ProductImageUrls = z.array(ProductImageUrl).max(MAX_PRODUCT_IMAGES);
export const ProductStock = z.number().int().min(0).max(MAX_PRODUCT_STOCK);

/** POST /api/sellers/me/products. The seller is the signed-in account, never a request field. */
export const CreateProductRequest = z
  .object({
    name: ProductName,
    description: ProductDescription.default(""),
    priceDrops: ProductPriceDrops,
    imageUrls: ProductImageUrls.default([]),
    /** Opening stock. Later changes go through stock adjustments. */
    stock: ProductStock.default(0),
    /** Optional link to one of the seller's own events, e.g. a tour shirt. */
    eventId: AppId.nullable().default(null),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

/**
 * PATCH /api/products/:id. Stock is deliberately absent: it changes only through
 * `AdjustStockRequest`, so a seller's edit can never overwrite units sold in the meantime.
 */
export const UpdateProductRequest = z
  .object({
    name: ProductName,
    description: ProductDescription,
    priceDrops: ProductPriceDrops,
    imageUrls: ProductImageUrls,
    eventId: AppId.nullable(),
    status: ProductStatus,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

/** POST /api/products/:id/stock: add (restock) or remove (correction) units. Never below zero. */
export const AdjustStockRequest = z
  .object({
    delta: z
      .number()
      .int()
      .min(-MAX_PRODUCT_STOCK)
      .max(MAX_PRODUCT_STOCK)
      .refine((d) => d !== 0, "A stock change can't be zero"),
  })
  .strict();
export type AdjustStockRequest = z.infer<typeof AdjustStockRequest>;

export const PhysicalProductDto = z.object({
  id: AppId,
  sellerId: AppId,
  eventId: AppId.nullable(),
  name: z.string(),
  description: z.string(),
  priceDrops: Drops,
  imageUrls: z.array(z.string()),
  stock: z.number().int().nonnegative(),
  status: ProductStatus,
  publishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PhysicalProductDto = z.infer<typeof PhysicalProductDto>;

// ---------------------------------------------------------------------------
// Cart, checkout and orders (XRPL-067 to 069)
// ---------------------------------------------------------------------------

/**
 * Shown wherever a customer checks out or reads an order. Payment is simulated for the hackathon:
 * placing an order moves no money, on the ledger or anywhere else.
 */
export const SIMULATED_PAYMENT_NOTICE =
  "Simulated payment: no money moves. This is a sandbox checkout, so you are never asked for card details and none are stored.";

/** What cancelling does to stock. Shown to sellers next to the cancel action. */
export const CANCEL_RESTOCK_NOTICE =
  "Cancelling an order returns its items to stock. A cancelled order can't be reopened.";

/** The label that sets ordinary goods apart from digital collectibles (NFTs). */
export const PHYSICAL_MERCH_LABEL = "Physical merchandise";

export const MAX_CART_LINES = 20;
export const MAX_LINE_QUANTITY = 20;

export const CartLine = z
  .object({ productId: AppId, quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) })
  .strict();
export type CartLine = z.infer<typeof CartLine>;

export const CartLines = z
  .array(CartLine)
  .min(1, "Your cart is empty")
  .max(MAX_CART_LINES)
  .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, "Each product can appear once");

/** POST /api/cart/quote: current names, prices and availability for a cart. Changes nothing. */
export const CartQuoteRequest = z.object({ items: CartLines }).strict();
export type CartQuoteRequest = z.infer<typeof CartQuoteRequest>;

/** Why a cart line can't be ordered as it stands. */
export const CartLineProblem = z.enum(["UNAVAILABLE", "OUT_OF_STOCK", "INSUFFICIENT_STOCK"]);
export type CartLineProblem = z.infer<typeof CartLineProblem>;

export const CartQuoteLine = z.object({
  productId: AppId,
  quantity: z.number().int().positive(),
  /** Null when the product is unavailable: nothing about a product that isn't on sale is revealed. */
  name: z.string().nullable(),
  sellerId: AppId.nullable(),
  sellerName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  unitPriceDrops: Drops.nullable(),
  lineTotalDrops: Drops.nullable(),
  stock: z.number().int().nonnegative().nullable(),
  problem: CartLineProblem.nullable(),
});
export type CartQuoteLine = z.infer<typeof CartQuoteLine>;

export const CartQuote = z.object({
  lines: z.array(CartQuoteLine),
  /** Sum of the lines that can be ordered. */
  subtotalDrops: Drops,
  /** True when every line can be ordered as it stands. */
  canCheckout: z.boolean(),
  payment: z.literal("SIMULATED"),
});
export type CartQuote = z.infer<typeof CartQuote>;

export const ShippingName = z.string().trim().min(2, "Enter the recipient's name").max(120);
export const ShippingAddress = z.string().trim().min(5, "Enter a delivery address").max(500);

/**
 * POST /api/orders. The buyer is the signed-in account. `.strict()` on purpose: there are no
 * payment fields, so a request carrying card details is rejected instead of stored. Prices are
 * never taken from the request: the server reads them when it places the order.
 */
export const PlaceOrderRequest = z
  .object({ items: CartLines, shippingName: ShippingName, shippingAddress: ShippingAddress })
  .strict();
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequest>;

/**
 * NEW: placed, stock taken. PROCESSING: the seller is preparing it. SHIPPED: sent.
 * FULFILLED: delivered, final. CANCELLED: final, and its items went back into stock.
 */
export const MerchOrderStatus = z.enum(["NEW", "PROCESSING", "SHIPPED", "FULFILLED", "CANCELLED"]);
export type MerchOrderStatus = z.infer<typeof MerchOrderStatus>;

/** Allowed order status changes. An order can be cancelled only before it ships. */
export const MERCH_ORDER_STATUS_CHANGES: Readonly<Record<MerchOrderStatus, readonly MerchOrderStatus[]>> = {
  NEW: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["FULFILLED"],
  FULFILLED: [],
  CANCELLED: [],
};

export const MERCH_ORDER_STATUS_LABELS: Readonly<Record<MerchOrderStatus, string>> = {
  NEW: "New",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

/** PATCH /api/orders/:id/status. Seller only. */
export const UpdateOrderStatusRequest = z.object({ status: MerchOrderStatus }).strict();
export type UpdateOrderStatusRequest = z.infer<typeof UpdateOrderStatusRequest>;

export const MerchOrderItemDto = z.object({
  productId: AppId,
  /** Name and unit price as they were when the order was placed. */
  name: z.string(),
  unitPriceDrops: Drops,
  quantity: z.number().int().positive(),
  lineTotalDrops: Drops,
});
export type MerchOrderItemDto = z.infer<typeof MerchOrderItemDto>;

/** An order as its buyer and its seller see it. Nobody else can read one. */
export const MerchOrderDto = z.object({
  id: AppId,
  buyerId: AppId,
  buyerName: z.string(),
  sellerId: AppId,
  sellerName: z.string(),
  status: MerchOrderStatus,
  items: z.array(MerchOrderItemDto),
  totalDrops: Drops,
  shippingName: z.string(),
  shippingAddress: z.string(),
  /** Always SIMULATED in this build: no payment was taken. */
  payment: z.literal("SIMULATED"),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MerchOrderDto = z.infer<typeof MerchOrderDto>;

/** 201 from POST /api/orders: one order per seller in the cart. */
export const PlaceOrderResult = z.object({ orders: z.array(MerchOrderDto), payment: z.literal("SIMULATED") });
export type PlaceOrderResult = z.infer<typeof PlaceOrderResult>;
