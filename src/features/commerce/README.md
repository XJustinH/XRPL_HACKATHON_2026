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

### Next

- After the schema lands: the Prisma `ProductStore` with DB tests, and the routes in the handoff's §5.5
  (`POST /api/sellers/me/products`, `PATCH /api/products/:id`, `GET /api/products/:id`,
  `GET /api/sellers/:id/products`, plus `POST /api/products/:id/stock`).
- XRPL-065 (seller management UI) and XRPL-066 (browsing, filling the storefront's merchandise section).
- Orders (XRPL-067/068) reserve and release stock through the same atomic adjustment.
