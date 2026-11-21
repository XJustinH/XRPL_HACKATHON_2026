# Storefront analytics (XRPL-078)

`/seller/analytics` gives a seller one summary of their whole storefront. It has three sections, and
they are **never added together**, because they do not settle the same way:

| Section | Counts | Currency | How it settles |
|---|---|---|---|
| Tickets | Validated primary sales across all the seller's events | XRP | XRP Ledger transactions |
| Physical merchandise | Orders for the seller's physical products | XRP | **Simulated payment**: no money moved |
| Digital collectibles | NFT sales of the seller's published collectibles | XRP | XRP Ledger transactions |

Code: `src/features/analytics/` (service and sections), `src/contracts/analytics.ts`,
`src/app/seller/analytics/page.tsx`, `GET /api/sellers/me/analytics`. Per-event ticket analytics
(XRPL-076/077) are unchanged at `/organiser/events/:id/analytics`.

## What each figure means

**Tickets.** Events, tickets sold (`primarySoldAt` set from a validated sale) and revenue (the sum of
accepted primary offers). Resales, check-ins and pending activity stay on each event's own analytics.

**Physical merchandise.**

- One line per order status: New, Processing, Shipped, Fulfilled, Cancelled, each with orders, units
  and value.
- **Order value** is the sum of the totals of orders that were not cancelled. Cancelled orders are
  shown on their own line and never counted.
- It is labelled "Simulated payment" everywhere: these are order values, not money received.

**Digital collectibles.**

- **Editions sold** and **revenue** count only editions whose purchase was recorded from a validated
  `tesSUCCESS` `NFTokenAcceptOffer` (`saleStatus` `SOLD`). Revenue is the sum of their sell-offer
  amounts.
- Minted and for-sale counts come from validated mints and live sell offers.
- **Waiting for the XRP Ledger** lists purchases, listings and mints that are signed or requested but
  not validated. They are never part of the figures above.
- Failed mints, failed listings and sell offers that are no longer on the ledger are listed as not
  completed, and not counted.
- Drafts and other sellers' collectibles are never included.

All XRP amounts are summed as integer drops, never as decimals.

## How the totals reconcile

Each section says in words whether its total agrees with the records behind it, and raises an alert
when it does not.

- **Merchandise against order records.** The sum of every order's stored total is compared with the
  sum of unit price x quantity over every order line. An order whose stored total differs from its own
  lines is named. The link beside it opens the orders.
- **Collectibles against ledger records.** Every counted sale is listed with its amount, time and the
  hash of the validated purchase it was recorded from, linked to the ledger explorer. The total is
  reconciled when every sold edition carries that hash. A sold edition without one is reported.
- **Read again from the ledger.** When the page loads, the 10 most recent sales are looked up on the
  ledger again (`checkSalesOnLedger`). Each shows one of:
  - *Checked on the ledger*: the transaction is validated with `tesSUCCESS`, is an
    `NFTokenAcceptOffer` and moved that edition's NFT.
  - *The ledger does not match this record*: the ledger contradicts it. This raises the alert.
  - *The ledger could not be read again just now*: the node was unreachable or no longer keeps the
    transaction. Nothing is claimed either way.

Verified on live XRPL Testnet by `tests/testnet/collectibles.testnet.test.ts`: after a real mint, sale
and purchase, the summary shows one sale at the listed price and the ledger check confirms it.

## Limitations

- The page lists the 50 most recent collectible sales and re-reads 10 of them. The totals always cover
  every sale.
- The ledger check confirms the transaction and the NFT it moved. It does not re-read the amount paid;
  the amount is the sell offer's, which the app verified on the ledger when the offer was listed.
- Collectible resales between collectors are not counted: there are no royalties, so they earn the
  seller nothing.
- No date range, no per-product or per-collectible breakdown, no chart and no export.
- Merchandise value is not income while payment is simulated.
- Figures are computed on each page view, from every order and edition the seller has.
