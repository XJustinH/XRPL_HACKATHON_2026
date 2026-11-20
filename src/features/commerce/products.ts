import {
  AdjustStockRequest,
  CommerceErrorCode,
  CreateProductRequest,
  EVENT_MANAGER_ROLES,
  MAX_PRODUCT_STOCK,
  PRODUCT_STATUS_CHANGES,
  ProductStatus,
  UpdateProductRequest,
  type PhysicalProductDto,
  type UserRole,
} from "@/contracts";
import type { AuthSession } from "@/lib/auth/session";
import { requireEventManager } from "@/lib/auth/permissions";
import { AppError, errors } from "@/lib/http/response";
import type { EventOwnership, ProductChanges, ProductRecord, ProductStore } from "./ports";

/**
 * Physical merchandise rules (XRPL-064), enforced on the server for every caller:
 *  - only seller accounts (SELLER or ORGANISER) create products, and only a product's own seller
 *    changes it;
 *  - a product can only be linked to one of the seller's own events;
 *  - status changes follow PRODUCT_STATUS_CHANGES, and publishing records when;
 *  - stock never goes below zero, and changes only through atomic adjustments;
 *  - drafts and archived products are visible to their seller only.
 * Inputs are re-validated here, so these rules hold whichever route or job calls the service.
 */

export type CommerceDeps = {
  products: ProductStore;
  events: EventOwnership;
  now?: () => Date;
};

const isSellerRole = (role: UserRole) => (EVENT_MANAGER_ROLES as readonly UserRole[]).includes(role);

export function toProductDto(p: ProductRecord): PhysicalProductDto {
  return {
    id: p.id,
    sellerId: p.sellerId,
    eventId: p.eventId,
    name: p.name,
    description: p.description,
    priceDrops: p.priceDrops,
    imageUrls: [...p.imageUrls],
    stock: p.stock,
    status: p.status,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function requireOwnEvent(deps: CommerceDeps, session: AuthSession, eventId: string): Promise<void> {
  if (!(await deps.events.isEventOwner(session.userId, eventId))) {
    throw new AppError(
      CommerceErrorCode.PRODUCT_EVENT_NOT_OWNED,
      "Products can only be linked to your own events.",
      403,
    );
  }
}

/** 404 if the product doesn't exist, 403 unless the session's seller account owns it. */
async function requireOwnProduct(deps: CommerceDeps, session: AuthSession, productId: string): Promise<ProductRecord> {
  const product = await deps.products.findById(productId);
  if (!product) throw errors.notFound("Product not found");
  if (product.sellerId !== session.userId || !isSellerRole(session.role)) {
    throw new AppError(CommerceErrorCode.PRODUCT_NOT_OWNED, "Only this product's seller can do this.", 403);
  }
  return product;
}

/** Creates a product for the signed-in seller. New products start as drafts. */
export async function createProduct(
  deps: CommerceDeps,
  session: AuthSession,
  input: unknown,
): Promise<PhysicalProductDto> {
  requireEventManager(session);
  const data = CreateProductRequest.parse(input);
  if (data.eventId) await requireOwnEvent(deps, session, data.eventId);

  const product = await deps.products.create({
    sellerId: session.userId,
    eventId: data.eventId,
    name: data.name,
    description: data.description,
    priceDrops: data.priceDrops,
    imageUrls: data.imageUrls,
    stock: data.stock,
    status: "DRAFT",
    publishedAt: null,
  });
  return toProductDto(product);
}

/** Edits a product's details or status. Stock changes go through `adjustProductStock`. */
export async function updateProduct(
  deps: CommerceDeps,
  session: AuthSession,
  productId: string,
  input: unknown,
): Promise<PhysicalProductDto> {
  const product = await requireOwnProduct(deps, session, productId);
  const patch = UpdateProductRequest.parse(input);
  if (patch.eventId) await requireOwnEvent(deps, session, patch.eventId);

  const changes: ProductChanges = { ...patch };
  if (patch.status && patch.status !== product.status) {
    if (!PRODUCT_STATUS_CHANGES[product.status].includes(patch.status)) {
      throw new AppError(
        CommerceErrorCode.INVALID_STATUS_CHANGE,
        `A ${product.status.toLowerCase()} product can't be changed to ${patch.status.toLowerCase()}.`,
        409,
        { from: product.status, to: patch.status },
      );
    }
    changes.publishedAt = patch.status === "PUBLISHED" ? (deps.now ?? (() => new Date()))() : null;
  }

  return toProductDto(await deps.products.update(product.id, changes));
}

/** Adds or removes units. Fails with 409 instead of letting stock go below zero. */
export async function adjustProductStock(
  deps: CommerceDeps,
  session: AuthSession,
  productId: string,
  input: unknown,
): Promise<PhysicalProductDto> {
  const product = await requireOwnProduct(deps, session, productId);
  const { delta } = AdjustStockRequest.parse(input);
  if (product.stock + delta > MAX_PRODUCT_STOCK) {
    throw errors.validation({ max: MAX_PRODUCT_STOCK }, `Stock can't exceed ${MAX_PRODUCT_STOCK} units`);
  }

  const updated = await deps.products.adjustStock(product.id, delta);
  if (!updated) {
    const current = (await deps.products.findById(product.id))?.stock ?? product.stock;
    throw new AppError(
      CommerceErrorCode.INSUFFICIENT_STOCK,
      `Only ${current} in stock, so ${-delta} can't be removed.`,
      409,
      { stock: current, delta },
    );
  }
  return toProductDto(updated);
}

/** A product as `viewer` may see it: published ones for everyone, others for their seller only. */
export async function getProduct(
  deps: CommerceDeps,
  productId: string,
  viewer: AuthSession | null,
): Promise<PhysicalProductDto> {
  const product = await deps.products.findById(productId);
  if (!product || (product.status !== "PUBLISHED" && product.sellerId !== viewer?.userId)) {
    throw errors.notFound("Product not found");
  }
  return toProductDto(product);
}

/** A seller's products: all of them for the seller, published ones for everyone else. */
export async function listSellerProducts(
  deps: CommerceDeps,
  sellerId: string,
  viewer: AuthSession | null,
): Promise<PhysicalProductDto[]> {
  const statuses = viewer?.userId === sellerId ? ProductStatus.options : (["PUBLISHED"] as const);
  return (await deps.products.listBySeller(sellerId, statuses)).map(toProductDto);
}
