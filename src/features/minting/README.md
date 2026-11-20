# src/features/minting — Agent B

Seller ticket minting UI (XRPL-024). Client code only: it calls `POST`/`GET /api/events/:id/mints`
and reuses the wallet feature's `TransactionApproval`. How mints are built,
approved and recorded is in [docs/xrpl/ticket-nft.md](../../../docs/xrpl/ticket-nft.md#minting-a-ticket-xrpl-024).

| File | What |
|---|---|
| `mint-tickets-panel.tsx` | Event picker, tiers with "Mint next ticket", the Xaman approval, and each ticket's status with NFT and transaction explorer links |

Usage (server component, signed-in seller). `issuerAddress` is the session's proven wallet (XRPL-012); when it
is null the panel links to `/connect` instead of minting:

```tsx
const events = await listSellerEventsForMinting(getDb(), session.userId); // @/lib/xrpl/tickets/minting
return <MintTicketsPanel events={events} issuerAddress={session.walletAddress} />;
```

It is currently shown on `/seller/events` below Agent C's placeholder. Agent C can move it into the event
management screens (XRPL-015/016) as long as it only renders for the event's seller.
