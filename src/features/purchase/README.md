# src/features/purchase — Agent B

Buying a ticket from a primary sell offer (XRPL-031). Client code only: it calls
`POST /api/offers/:id/accept-intent` and `GET /api/offers/:id`, and reuses the wallet feature's
`TransactionApproval`. How purchases are prepared, approved and recorded is in
[docs/xrpl/offers.md](../../../docs/xrpl/offers.md#buying-a-ticket-xrpl-031).

| File | What |
|---|---|
| `buy-ticket.tsx` | "Buy for X XRP" for one offer: the Xaman approval, then the validated outcome (you own it, still available, or sold to someone else). Asks a buyer without a proven wallet to connect first |

Usage (server component): pass an offer from `listPrimaryOffers(db, eventId)` and the session's proven wallet.

```tsx
<BuyTicket offer={offer} buyerAddress={session?.walletAddress ?? null} />
```

It is currently shown on the public event page (`/events/:id`, Agent C's page) for the cheapest live offer of
each tier. Agent C's checkout (XRPL-030) can move it into the ticket selection screens.
