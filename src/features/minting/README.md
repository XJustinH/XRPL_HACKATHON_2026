# src/features/minting — Agent B

Seller ticket minting and primary listing UI (XRPL-024, XRPL-025, XRPL-029). Client code only: it calls
`POST`/`GET /api/events/:id/mints` and `POST /api/tickets/:id/primary-offers`, and reuses the wallet feature's
`TransactionApproval`. How mints and offers are built, approved and recorded is in
[docs/xrpl/ticket-nft.md](../../../docs/xrpl/ticket-nft.md#minting-a-ticket-xrpl-024) and
[docs/xrpl/offers.md](../../../docs/xrpl/offers.md).

| File | What |
|---|---|
| `mint-tickets-panel.tsx` | One event's tiers with "Mint next ticket" and "Mint all N remaining" (a run of Xaman approvals with progress, XRPL-025), "List N for sale" at the tier price (a run of sell-offer approvals, XRPL-029), minted, pending and failed tickets listed separately with each ticket's sale status and explorer links, and **Check against the ledger** (XRPL-026) |

Usage: Agent C's event page (`/seller/events/:id`, a server component) renders it for the event's owner.
`issuerAddress` is the session's proven wallet (XRPL-012); when it is null the panel links to `/connect`
instead of minting. `tiersVersion` should change when the tiers do, so the list reloads:

```tsx
<MintTicketsPanel
  eventId={event.id}
  issuerAddress={session.walletAddress}
  tiersVersion={event.tiers.map((tier) => `${tier.id}:${tier.totalSupply}`).join("|")}
/>
```
