/**
 * Interfaces the merchandise service depends on (XRPL-064).
 *  - ProductStore: database access. The Prisma implementation follows the PhysicalProduct table
 *    (schema request in src/features/commerce/README.md); tests use ./testing/fakes.ts.
 *  - EventOwnership: whether a seller owns an event, from the auth module's `isEventOwner`.
 */
import type { ProductStatus } from "@/contracts/commerce";

/** A stored physical product. Never an NFT: it has no ledger identifiers. */
export type ProductRecord = {
  id: string;
  sellerId: string;
  eventId: string | null;
  name: string;
  description: string;
  /** Integer drops as a decimal string. */
  priceDrops: string;
  imageUrls: string[];
  stock: number;
  status: ProductStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewProduct = Omit<ProductRecord, "id" | "createdAt" | "updatedAt">;

/** Fields an edit may change. Stock is not one of them: see `adjustStock`. */
export type ProductChanges = Partial<
  Pick<ProductRecord, "name" | "description" | "priceDrops" | "imageUrls" | "eventId" | "status" | "publishedAt">
>;

export interface ProductStore {
  create(product: NewProduct): Promise<ProductRecord>;
  findById(id: string): Promise<ProductRecord | null>;
  update(id: string, changes: ProductChanges): Promise<ProductRecord>;
  /**
   * Adds `delta` to the stock in one atomic step. Returns the updated product, or null when the
   * result would be negative (nothing changes then). Concurrent adjustments can never oversell.
   */
  adjustStock(id: string, delta: number): Promise<ProductRecord | null>;
  /** The seller's products with one of `statuses`, newest first. */
  listBySeller(sellerId: string, statuses: readonly ProductStatus[]): Promise<ProductRecord[]>;
}

export interface EventOwnership {
  isEventOwner(userId: string, eventId: string): Promise<boolean>;
}
