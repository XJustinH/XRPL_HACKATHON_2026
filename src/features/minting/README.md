# src/features/minting — Agent B

Seller ticket minting UI (XRPL-024). Client code only: it calls `POST`/`GET /api/events/:id/mints`
and reuses the wallet feature's `TransactionApproval`. How mints are built,
approved and recorded is in [docs/xrpl/ticket-nft.md](../../../docs/xrpl/ticket-nft.md#minting-a-ticket-xrpl-024).

| File | What |
|---|---|
| `mint-tickets-panel.tsx` | One event's tiers with "Mint next ticket", the Xaman approval, each ticket's status with NFT and transaction explorer links, and **Check against the ledger** (XRPL-026), which shows the mapping report |

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
