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
