# src/features/transfers

Screens for passing a ticket on: resale, private sale and gift (XRPL-034, 038, 039, 040, 041). The server rules
and routes live in `src/lib/xrpl/offers/holder.ts`; see `docs/xrpl/offers.md`.

| Page | What it does |
|---|---|
| `/tickets/:id` | One ticket: event, tier, status, owner and NFT, each with Testnet explorer links (XRPL-034). The holder gets **Show check-in code** and the transfer panel |
| `/offers/:id` | One offer. A private sale or gift is visible only to the wallet it names; a resale listing only while the in-app resale rule lists it. The recipient or buyer accepts here |
| `/resale` | Every public resale listing, through the resale rule (XRPL-038) |

| File | Purpose |
|---|---|
| `ticket-transfer-panel.tsx` | Sell / Sell to a friend / Gift. A gift asks for confirmation first, because once accepted it can't be undone. Once the offer is live, shows the link to send |
| `accept-offer.tsx` | Accept a gift or private sale, or buy a resale ticket. Success shows only once the ledger validated it |
| `server.ts` | The holder's open offer, what a visitor may see of an offer, and the resale listings |
| `api.ts` | Fetch helper, idempotency keys and address formatting |

Every step is approved in the user's own Xaman wallet with Agent B's `TransactionApproval`. Tests:
`transfers.test.tsx` (components), and the resale page in `tests/e2e/`.

Limitation: an offer can't be cancelled from these screens yet (XRPL-042).
