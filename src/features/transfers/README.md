# src/features/transfers

Screens for passing a ticket on: resale, private sale and gift (XRPL-034, 038, 039, 040, 041). The server rules
and routes live in `src/lib/xrpl/offers/holder.ts`; see `docs/xrpl/offers.md`.

| Page | What it does |
|---|---|
| `/tickets/:id` | One ticket: event, tier, status, owner and NFT, each with Testnet explorer links (XRPL-034). The holder gets **Show check-in code** and the transfer panel |
| `/offers/:id` | One offer. A private sale or gift is visible only to the wallet it names; a resale listing only while the in-app resale rule lists it. The recipient or buyer accepts here |
| `/resale` | Every public resale listing, through the resale rule (XRPL-038). `?eventId=` shows one event's, with the reason when there are none |
| `/events/:id` | "Tickets from other fans": the event's first four listings, then a link to the rest |

| File | Purpose |
|---|---|
| `ticket-transfer-panel.tsx` | Sell / Sell to a friend / Gift. A gift asks for confirmation first, because once accepted it can't be undone. Once the offer is live, shows the link to send and **Cancel this offer** (XRPL-042), which says "cancelled" only once the ledger shows it |
| `accept-offer.tsx` | Accept a gift or private sale, or buy a resale ticket. Success shows only once the ledger validated it |
| `resale-listing-card.tsx` | One listing: ticket, price against face value, seller, when it was listed, and the offer's validated transaction on the explorer |
| `server.ts` | The holder's open offer, what a visitor may see of an offer, and the resale listings. Before an offer is shown, it settles what's in flight and re-checks the ledger, so one taken or cancelled elsewhere shows as closed |
| `api.ts` | Fetch helper, idempotency keys and address formatting |

Every step is approved in the user's own Xaman wallet with Agent B's `TransactionApproval`.

**What's never shown:** primary offers (those are on the event page), a private sale or gift to anyone but its
recipient, resale listings the resale rule hides, and offers that can't complete. That last group covers offers
no longer active and offers for a ticket already used to enter the event. Those show as closed.

Tests: `transfers.test.tsx` (components), `server.int.test.ts` (what each visitor may see, on Postgres) and the
resale page in `tests/e2e/`.

Limitation: an offer closed outside the app stays on `/resale` until someone opens it or tries to buy it,
when the ledger check closes it. See `docs/xrpl/offers.md`.
