# src/features/purchase — Agent B

Buying a ticket from a primary sell offer (XRPL-031, XRPL-035). Client code only: it calls
`POST /api/offers/:id/accept-intent` and `GET /api/offers/:id`, and reuses the wallet feature's
`TransactionApproval`. How purchases are prepared, approved and recorded is in
[docs/xrpl/offers.md](../../../docs/xrpl/offers.md#buying-a-ticket-xrpl-031).

| File | What |
|---|---|
| `buy-ticket.tsx` | "Buy for X XRP" for one offer: the Xaman approval, then the validated outcome (you own it, still available, or it went to someone else). When the ticket went to someone else, before or after the approval, it says so and offers **See what's available now** instead of trying the same ticket again (XRPL-035). Asks a buyer without a proven wallet to connect first |

Usage (server component): pass the offer the page confirmed (`selectTierForPurchase`,
`src/features/events/purchase-selection.ts`) and the session's proven wallet. Key it by the offer, so
refreshing onto another ticket starts a clean purchase.

```tsx
<BuyTicket key={offer.offerId} offer={offer} buyerAddress={session?.walletAddress ?? null} />
```

It finishes the purchase on Agent C's purchase page (`/events/:id/purchase?tier=…`, XRPL-019), for the offer that
page confirmed. It sits in that page's wallet panel (XRPL-030) and appears only when the wallet is ready to pay.
**See what's available now** refreshes that page, which picks the ticket type's next ticket or says it has sold out.
