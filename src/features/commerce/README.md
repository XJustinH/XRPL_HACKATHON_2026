# src/features/commerce — Agent E

Physical merchandise and digital collectibles (P1, XRPL-064..078). Contracts in `src/contracts/commerce.ts`.

## Physical products (XRPL-064)

Merchandise is ordinary goods, kept apart from tickets: a product has no ledger identifiers, its own table,
and its own contract (`PhysicalProductDto`). Prices are integer drops of Testnet XRP, like every other amount
in the app. Real-money payment is deferred for the hackathon (`docs/architecture.md` §7).

A product has a seller, an optional link to one of the seller's events, a name, a description, a price, up
to 6 https image URLs (the first is the cover), stock, and a status.

### Rules (`products.ts`, enforced on the server)

| Rule | Error |
|---|---|
| Only seller accounts (`SELLER` or `ORGANISER`) create products. The seller is the signed-in account, never a request field | 403 `ROLE_REQUIRED` / `ONBOARDING_REQUIRED` |
| Only a product's own seller edits it or changes its stock | 404 if missing, 403 `PRODUCT_NOT_OWNED` |
| A product can be linked only to the seller's own event | 403 `PRODUCT_EVENT_NOT_OWNED` |
| Price above zero, stock a whole number from 0 to 100,000, images https only | 400 `VALIDATION_FAILED` |
| New products are drafts. Status changes: draft ↔ published, either → archived, archived → draft. Publishing records `publishedAt` | 409 `INVALID_STATUS_CHANGE` |
| Edits can't set stock. Stock changes only through atomic adjustments (`delta`), so an edit can never overwrite units sold in the meantime, and stock never goes below zero, even when changes arrive at the same time | 409 `INSUFFICIENT_STOCK` |
| Drafts and archived products are visible to their seller only. Everyone else gets 404 | 404 |

### Files

| File | Purpose |
|---|---|
| `ports.ts` | `ProductStore` and `EventOwnership` interfaces |
| `products.ts` | The service: create, update, adjust stock, get, list |
| `testing/fakes.ts` | In-memory `ProductStore` (atomic stock changes) and `EventOwnership` for tests |
| `products.test.ts` | Unit tests for every rule above |
| `product-store.ts` | `PrismaProductStore`: the `ProductStore` on the `PhysicalProduct` table (XRPL-065) |
| `server.ts` | `commerceDeps()`: the service wired to Postgres for routes and pages |

### Schema request: PhysicalProduct (XRPL-064)

For Agent A, who owns `prisma/`. It unblocks the Prisma `ProductStore`, the routes, and XRPL-065 to 069.

```prisma
enum ProductStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

/// Physical merchandise (XRPL-064). Ordinary goods, not NFTs: no ledger identifiers.
model PhysicalProduct {
  id          String        @id @default(uuid()) @db.Uuid
  sellerId    String        @db.Uuid
  /// Optional link to one of the seller's own events (e.g. a tour shirt).
  eventId     String?       @db.Uuid
  name        String
  description String        @default("")
  /// Integer drops as a decimal string, above zero.
  priceDrops  String
  /// https image URLs; the first is the cover. At most 6.
  imageUrls   String[]      @default([])
  /// Units available to sell. Never negative.
  stock       Int           @default(0)
  status      ProductStatus @default(DRAFT)
  publishedAt DateTime?     @db.Timestamptz(3)
  createdAt   DateTime      @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime      @updatedAt @db.Timestamptz(3)

  seller User   @relation("ProductSeller", fields: [sellerId], references: [id], onDelete: Restrict)
  event  Event? @relation(fields: [eventId], references: [id], onDelete: SetNull)

  @@index([sellerId, status, createdAt])
}
```

Back-relations: `User.products PhysicalProduct[] @relation("ProductSeller")` and `Event.products PhysicalProduct[]`.

Hand-written constraints for the migration. They mirror the contract, so the database is the last guard:

```sql
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_priceDrops_positive"
  CHECK ("priceDrops" ~ '^[1-9][0-9]{0,17}$');
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_stock_nonnegative"
  CHECK ("stock" >= 0);
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_images_limit"
  CHECK (cardinality("imageUrls") <= 6);
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_published_has_date"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);
```

Once the table exists, the Prisma `ProductStore` adjusts stock in one statement
(`updateMany` where `stock >= -delta`, incrementing by `delta`) and treats zero rows as "insufficient
stock", with the CHECK constraint as a backstop.

The schema above landed in migration `20261121005533_add_physical_products`.

## Selling, cart, orders and order history (XRPL-065 to 069)

Full description, routes, stock and status rules and limitations: [`docs/merch.md`](../../../docs/merch.md).

- **Payment is simulated.** Placing an order moves no money, submits nothing to the ledger, and asks for
  and stores no card details.
- **Placing an order takes stock exactly once.** The products are row-locked and decremented in the
  transaction that creates the order, and `POST /api/orders` runs through `runIdempotent`, so a repeated
  request replays instead of ordering twice.
- **Cancelling restocks.** A cancelled order's items go back into stock, once.
- **Order statuses:** new → processing → shipped → fulfilled, and new or processing → cancelled
  (`MERCH_ORDER_STATUS_CHANGES`).
- **Who reads an order:** its purchaser and its seller. Everyone else gets 404.

| File | Purpose |
|---|---|
| `orders.ts` | Cart quote, place order, order lists, read an order, change status (with restock on cancel) |
| `orders.int.test.ts` | DB tests: stock taken once (concurrent last unit, replayed request), cancel restocks, state machine, who can read |
| `route-helpers.ts` | `:id` parsing and headers shared by the merchandise routes |
| `product-manager.tsx` | Seller UI: create and edit products, photos, stock, publish and withdraw |
| `order-status-controls.tsx` | Seller's status buttons for an order |
| `order-summary.tsx` | Order card, items list and status badge shared by the order pages |
| `seller-merch-section.tsx` | `SellerMerchSection({ sellerId })` for the public storefront, plus `ProductCard` |
| `add-to-cart.tsx` | Add-to-cart control. Not offered for unpublished or out-of-stock products |
| `cart-store.ts` | The cart in `localStorage`: ids, quantities and names only |
| `cart-view.tsx`, `cart-view.test.tsx` | Cart review, subtotal and simulated checkout, with its test |

Pages: `/seller/products`, `/sellers/[id]/merch`, `/products/[id]`, `/cart`, `/orders`, `/orders/[id]`.

### Next

- Digital collectibles (XRPL-070 to 075) and merchandise in analytics (XRPL-078).
