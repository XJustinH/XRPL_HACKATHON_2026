// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { MAX_PRODUCT_IMAGES, MAX_PRODUCT_STOCK, PhysicalProductDto, type UserRole } from "@/contracts";
import type { AuthSession } from "@/lib/auth/session";
import {
  adjustProductStock,
  createProduct,
  getProduct,
  listSellerProducts,
  updateProduct,
  type CommerceDeps,
} from "./products";
import { FakeEventOwnership, InMemoryProductStore } from "./testing/fakes";

const SELLER = "11111111-1111-4111-8111-111111111111";
const OTHER_SELLER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const OWN_EVENT = "44444444-4444-4444-8444-444444444444";
const OTHER_EVENT = "55555555-5555-4555-8555-555555555555";
const PUBLISHED_AT = new Date("2026-11-20T18:00:00.000Z");

function session(userId: string, role: UserRole = "SELLER", onboarded = true): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role,
    onboardedAt: onboarded ? new Date() : null,
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: null,
    walletVerifiedAt: null,
  };
}

function setup(): CommerceDeps {
  return {
    products: new InMemoryProductStore(),
    events: new FakeEventOwnership([
      [SELLER, OWN_EVENT],
      [OTHER_SELLER, OTHER_EVENT],
    ]),
    now: () => PUBLISHED_AT,
  };
}

const shirt = { name: "Tour T-shirt", priceDrops: "15000000", stock: 3, imageUrls: ["https://example.com/shirt.png"] };

describe("creating products", () => {
  it("creates a draft owned by the signed-in seller", async () => {
    const product = await createProduct(setup(), session(SELLER), { ...shirt, description: "Black, cotton" });

    expect(product).toMatchObject({
      sellerId: SELLER,
      name: "Tour T-shirt",
      description: "Black, cotton",
      priceDrops: "15000000",
      imageUrls: ["https://example.com/shirt.png"],
      stock: 3,
      status: "DRAFT",
      publishedAt: null,
      eventId: null,
    });
  });

  it("lets organiser accounts sell too", async () => {
    await expect(createProduct(setup(), session(SELLER, "ORGANISER"), shirt)).resolves.toMatchObject({
      status: "DRAFT",
    });
  });

  it("rejects customers and accounts that haven't chosen a role", async () => {
    await expect(createProduct(setup(), session(CUSTOMER, "CUSTOMER"), shirt)).rejects.toMatchObject({
      code: "ROLE_REQUIRED",
      status: 403,
    });
    await expect(createProduct(setup(), session(SELLER, "SELLER", false), shirt)).rejects.toMatchObject({
      code: "ONBOARDING_REQUIRED",
      status: 403,
    });
  });

  it("never takes the seller from the request", async () => {
    await expect(createProduct(setup(), session(SELLER), { ...shirt, sellerId: OTHER_SELLER })).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it.each([
    ["a zero price", { priceDrops: "0" }],
    ["a fractional price", { priceDrops: "1.5" }],
    ["negative stock", { stock: -1 }],
    ["fractional stock", { stock: 1.5 }],
    ["too much stock", { stock: MAX_PRODUCT_STOCK + 1 }],
    ["an http image", { imageUrls: ["http://example.com/a.png"] }],
    ["a script URL as image", { imageUrls: ["javascript:alert(1)"] }],
    ["too many images", { imageUrls: Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, i) => `https://example.com/${i}.png`) }],
    ["a one-letter name", { name: "X" }],
  ])("rejects %s", async (_label, change) => {
    await expect(createProduct(setup(), session(SELLER), { ...shirt, ...change })).rejects.toBeInstanceOf(ZodError);
  });

  it("links a product only to the seller's own event", async () => {
    const deps = setup();
    await expect(createProduct(deps, session(SELLER), { ...shirt, eventId: OWN_EVENT })).resolves.toMatchObject({
      eventId: OWN_EVENT,
    });
    await expect(createProduct(deps, session(SELLER), { ...shirt, eventId: OTHER_EVENT })).rejects.toMatchObject({
      code: "PRODUCT_EVENT_NOT_OWNED",
      status: 403,
    });
  });
});

describe("editing products", () => {
  it("lets only the product's own seller edit it", async () => {
    const deps = setup();
    const product = await createProduct(deps, session(SELLER), shirt);

    await expect(updateProduct(deps, session(SELLER), product.id, { priceDrops: "12000000" })).resolves.toMatchObject({
      priceDrops: "12000000",
    });
    await expect(updateProduct(deps, session(OTHER_SELLER), product.id, { name: "Mine now" })).rejects.toMatchObject({
      code: "PRODUCT_NOT_OWNED",
      status: 403,
    });
    // An owner whose account is no longer a seller account can't edit either.
    await expect(updateProduct(deps, session(SELLER, "CUSTOMER"), product.id, { name: "x y" })).rejects.toMatchObject({
      code: "PRODUCT_NOT_OWNED",
    });
  });

  it("returns 404 for a product that doesn't exist", async () => {
    await expect(
      updateProduct(setup(), session(SELLER), "66666666-6666-4666-8666-666666666666", { name: "Hoodie" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("doesn't let an edit set stock directly", async () => {
    const deps = setup();
    const product = await createProduct(deps, session(SELLER), shirt);
    await expect(updateProduct(deps, session(SELLER), product.id, { stock: 99 })).rejects.toBeInstanceOf(ZodError);
  });

  it("follows the allowed status changes and records when a product was published", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);
    const seller = session(SELLER);

    await expect(updateProduct(deps, seller, id, { status: "PUBLISHED" })).resolves.toMatchObject({
      status: "PUBLISHED",
      publishedAt: PUBLISHED_AT.toISOString(),
    });
    await expect(updateProduct(deps, seller, id, { status: "ARCHIVED" })).resolves.toMatchObject({
      status: "ARCHIVED",
      publishedAt: null,
    });
    await expect(updateProduct(deps, seller, id, { status: "PUBLISHED" })).rejects.toMatchObject({
      code: "INVALID_STATUS_CHANGE",
      status: 409,
    });
    await expect(updateProduct(deps, seller, id, { status: "DRAFT" })).resolves.toMatchObject({ status: "DRAFT" });
  });
});

describe("stock", () => {
  it("restocks and removes units", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);

    await expect(adjustProductStock(deps, session(SELLER), id, { delta: 5 })).resolves.toMatchObject({ stock: 8 });
    await expect(adjustProductStock(deps, session(SELLER), id, { delta: -8 })).resolves.toMatchObject({ stock: 0 });
  });

  it("never goes below zero", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);

    await expect(adjustProductStock(deps, session(SELLER), id, { delta: -4 })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      status: 409,
      details: { stock: 3, delta: -4 },
    });
    await expect(getProduct(deps, id, session(SELLER))).resolves.toMatchObject({ stock: 3 });
  });

  it("can't oversell when removals arrive at the same time", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => adjustProductStock(deps, session(SELLER), id, { delta: -1 })),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    await expect(getProduct(deps, id, session(SELLER))).resolves.toMatchObject({ stock: 0 });
  });

  it("rejects a zero change, a change past the maximum, and other sellers", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);

    await expect(adjustProductStock(deps, session(SELLER), id, { delta: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(adjustProductStock(deps, session(SELLER), id, { delta: MAX_PRODUCT_STOCK })).rejects.toMatchObject({
      status: 400,
    });
    await expect(adjustProductStock(deps, session(OTHER_SELLER), id, { delta: 1 })).rejects.toMatchObject({
      code: "PRODUCT_NOT_OWNED",
    });
  });
});

describe("visibility", () => {
  it("shows drafts to their seller only, and published products to everyone", async () => {
    const deps = setup();
    const { id } = await createProduct(deps, session(SELLER), shirt);

    await expect(getProduct(deps, id, session(SELLER))).resolves.toMatchObject({ status: "DRAFT" });
    await expect(getProduct(deps, id, null)).rejects.toMatchObject({ status: 404 });
    await expect(getProduct(deps, id, session(CUSTOMER, "CUSTOMER"))).rejects.toMatchObject({ status: 404 });

    await updateProduct(deps, session(SELLER), id, { status: "PUBLISHED" });
    await expect(getProduct(deps, id, null)).resolves.toMatchObject({ status: "PUBLISHED" });
  });

  it("lists every product for its seller but only published ones for others", async () => {
    const deps = setup();
    const draft = await createProduct(deps, session(SELLER), { ...shirt, name: "Draft hoodie" });
    const live = await createProduct(deps, session(SELLER), { ...shirt, name: "Live poster" });
    await updateProduct(deps, session(SELLER), live.id, { status: "PUBLISHED" });

    const own = await listSellerProducts(deps, SELLER, session(SELLER));
    expect(own.map((p) => p.id)).toEqual([live.id, draft.id]);
    const publicView = await listSellerProducts(deps, SELLER, null);
    expect(publicView.map((p) => p.id)).toEqual([live.id]);
  });
});

describe("separation from NFTs", () => {
  it("has no ledger identifiers in the product contract", () => {
    const fields = Object.keys(PhysicalProductDto.shape);
    for (const ledgerField of ["nftokenId", "offerIndex", "issuerAddress", "mintTxHash", "txHash"]) {
      expect(fields).not.toContain(ledgerField);
    }
  });
});
