# Physical merchandise (XRPL-065 to XRPL-069)

Sellers list ordinary physical goods, customers put them in a cart and order them, and sellers work the
orders through to delivery. It builds on the product model and rules from XRPL-064
(`src/features/commerce/README.md`).

Merchandise is not an NFT. A product and an order have no ledger identifiers, nothing about them is written
to the XRP Ledger, and every page that shows one carries the label **Physical merchandise** so it is not
taken for a ticket or a digital collectible.

## Payment is simulated

**No money moves when an order is placed.** Checkout is a sandbox: it records the order and takes the units
out of stock, and that is all. It does not submit an XRPL transaction, charge a card or contact a payment
provider.

- Checkout asks for a delivery name and a delivery address. There are no card fields.
- The order endpoint rejects any field it does not know (`PlaceOrderRequest` is strict), so a request that
  carries card details gets `400` and nothing from it is stored.
- The cart page, the order confirmation, the order pages and the API response (`payment: "SIMULATED"`) all
  say that payment is simulated.
- Prices are shown in Testnet XRP (integer drops in the database and the API), like the rest of the app.

## What each role can do

| Who | Can |
|---|---|
| Seller or organiser account | Create products, edit details and photos, change stock, publish, unpublish and archive their own products. See the orders placed with them and change their status |
| Anyone, signed in or not | Browse a seller's published products, open a product page, fill a cart and see its subtotal |
| Signed-in account | Place an order, see their own order history and each order's detail |

Only the owner changes a product: the server checks it on every request (`403 PRODUCT_NOT_OWNED`), and
creating a product has no field that could name another seller. Only the order's seller changes its status.
Only the purchaser and the order's seller can read an order. Everyone else gets `404`, the same answer as
for an order that does not exist.

## Pages

| Page | What it is |
|---|---|
| `/seller/products` | Seller: add a product, edit it, add or remove stock, publish or withdraw it, and work incoming orders |
| `/sellers/[id]/merch` | A seller's published merchandise |
| `/products/[id]` | Product page: photos, price, stock, add to cart |
| `/cart` | Cart review, subtotal and checkout |
| `/orders` | The customer's order history |
| `/orders/[id]` | One order: items, total, fulfilment state, delivery details. The seller also gets the status buttons |

`SellerMerchSection({ sellerId })` in `src/features/commerce/seller-merch-section.tsx` is the block for the
public storefront (`/sellers/[id]`): a server component that lists the seller's published products.

## API

All responses use the standard envelope. Amounts are integer drops as decimal strings.

| Method and path | Who | What it does |
|---|---|---|
| `POST /api/sellers/me/products` | Seller | Create a product (starts as a draft) |
| `GET /api/sellers/me/products` | Seller | Own products, drafts and archived included |
| `GET /api/sellers/:id/products` | Anyone | A seller's published products (the seller also sees their own drafts) |
| `GET /api/products/:id` | Anyone | One product. Drafts and archived products are `404` except for their seller |
| `PATCH /api/products/:id` | Owner | Edit name, description, price, photos, event link or status |
| `POST /api/products/:id/stock` | Owner | Add or remove units: `{ "delta": 10 }` or `{ "delta": -2 }` |
| `POST /api/cart/quote` | Anyone | Current names, prices, availability and subtotal for a cart. Reserves nothing |
| `POST /api/orders` | Signed in | Place the order. Needs an `Idempotency-Key` header |
| `GET /api/orders/mine` | Signed in | Own orders, newest first |
| `GET /api/orders/:id` | Buyer or seller | One order |
| `GET /api/sellers/me/orders` | Seller | Orders placed with the seller |
| `PATCH /api/orders/:id/status` | Order's seller | Change the status: `{ "status": "SHIPPED" }` |

Error codes specific to merchandise: `PRODUCT_NOT_OWNED` (403), `PRODUCT_EVENT_NOT_OWNED` (403),
`ORDER_NOT_SELLER` (403), `PRODUCT_UNAVAILABLE` (409), `INSUFFICIENT_STOCK` (409),
`INVALID_STATUS_CHANGE` (409).

## Cart and checkout

The cart lives in the browser's `localStorage` (`xt.merch.cart.v1`). It holds product ids, quantities and
the name shown when the item was added. It holds no prices, no address and no payment details, and it is
not shared between devices. A cart has at most 20 lines and 20 units per line.

The cart page asks the server for a quote, so names, prices and the subtotal are always current. A line
that can no longer be ordered is marked (no longer available, out of stock, or not enough in stock) and
checkout stays disabled until it is fixed. A product that is unpublished or out of stock has no
add-to-cart button on its page.

Placing an order sends only the lines and the delivery details. The server reads the prices itself and
copies each product's name and unit price onto the order, so a later edit to a product never changes a
past order. A cart with products from several sellers becomes **one order per seller**, created together:
if any line fails, no order is created and no stock changes.

## Stock rules

Stock is `PhysicalProduct.stock`, the units available to sell. It never goes below zero (the database has
a CHECK constraint as the last guard).

| Event | Effect on stock |
|---|---|
| Order placed | Each line's quantity is taken out of stock, in the same database transaction that creates the order |
| Order cancelled | Each line's quantity is **returned to stock**, in the same transaction that marks the order cancelled |
| Processing, shipped, fulfilled | No change. The units left stock when the order was placed |
| Seller adds or removes units | One atomic update, refused with `409 INSUFFICIENT_STOCK` if it would go below zero |

Placing an order decrements stock **exactly once**:

1. The transaction locks the ordered product rows (`SELECT ... FOR UPDATE`, always in id order so two
   checkouts queue instead of deadlocking), checks that each is published and has enough stock, then
   decrements and creates the orders. Two customers ordering the last unit at the same moment get one
   order and one `409 INSUFFICIENT_STOCK`.
2. `POST /api/orders` requires an `Idempotency-Key` header and runs through `runIdempotent`
   (`src/lib/xrpl/idempotency.ts`). A double click or a retried request with the same key replays the
   first response (`Idempotent-Replayed: true`) instead of ordering again. The cart page sends one key per
   distinct order.

**Cancelling restocks.** When a seller cancels an order, its items go back into stock straight away and can
be bought by someone else. This happens once per order (`MerchOrder.restockedAt` records it, and the order
row is locked while its status changes), so cancelling twice cannot add the units twice. The seller's page
says this next to the cancel button and asks for confirmation.

## Order statuses

| Status | Meaning | Can change to |
|---|---|---|
| `NEW` | Placed. Stock has been taken | `PROCESSING`, `CANCELLED` |
| `PROCESSING` | The seller is preparing it | `SHIPPED`, `CANCELLED` |
| `SHIPPED` | Sent | `FULFILLED` |
| `FULFILLED` | Delivered. Final | none |
| `CANCELLED` | Final. Its items went back into stock | none |

Any other change is refused with `409 INVALID_STATUS_CHANGE`. Asking for the status an order already has
changes nothing. The table is `MERCH_ORDER_STATUS_CHANGES` in `src/contracts/commerce.ts`, and both the
server and the seller's buttons use it.

## Data model

Migration `20261121040120_add_merch_orders` adds:

- `MerchOrderStatus` enum: `NEW`, `PROCESSING`, `SHIPPED`, `FULFILLED`, `CANCELLED`.
- `MerchOrder`: buyer, seller, status, `totalDrops`, `shippingName`, `shippingAddress`, `restockedAt`.
- `MerchOrderItem`: order, product, and the copied `productName`, `unitPriceDrops` and `quantity`. One
  line per product in an order.

CHECK constraints keep the order total and unit prices positive and quantities at 1 or more.

## Limitations

- Payment is simulated. There is no payment, refund or payout flow, and order totals are not settled on the
  XRP Ledger.
- Only the seller can cancel an order. A customer cannot cancel from their order page.
- A seller can order their own product. Nothing blocks it.
- No delivery charge, tax, discount codes or tracking numbers. The total is the sum of the lines.
- The cart is per browser. It is not saved to the account and does not follow the customer to another
  device. Adding to the cart does not reserve stock: stock is taken only when the order is placed.
- Photos are https links the seller pastes in. There is no upload (XRPL-070/071 covers uploads).
- Order lists are not paginated, and there are no order notifications or emails.
- Merchandise is not in the organiser analytics yet (XRPL-078).
