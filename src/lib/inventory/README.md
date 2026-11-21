# src/lib/inventory — Agent A

Primary inventory and sell-out state (XRPL-020). Reconciling confirmed sales (XRPL-032) and
syncing ownership after transfers (XRPL-043) will live here too.

## The rules

Figures come only from records written after a **validated** XRPL transaction. Client claims,
sign requests and cached owners never count.

| Situation | How it counts |
|---|---|
| Ticket `MINTED` **and** `primarySoldAt` set (a validated primary sale, XRPL-032) | **sold**: the only thing that reduces `remaining` |
| Supply not minted yet, or a mint that is `PENDING` / `SUBMITTED` / `FAILED` | **remaining**: the seller can still mint and sell it |
| Purchase in flight: an `NFTokenAcceptOffer` `LedgerTransaction` still `PENDING` for an unsold ticket | **pending**: counted inside `remaining`, never as sold |
| Primary offer `EXPIRED`, `CANCELLED`, `FAILED` or `STALE` | ignored: the ticket stays unsold and can be offered again |
| Primary offer `ACTIVE` on an unsold ticket | sets `fromPriceDrops` (the cheapest live ask) |
| **Sold out** | the event has supply **and** every unit of every tier has a validated sale |

- `remaining = totalSupply - sold` per tier, summed over the event.
- A purchase that's still pending can never make an event sold out, so resale can't open early.
- Inventory is app-side. A ticket moved directly on XRPL outside the app isn't a "sale" here.
  Reconciliation (XRPL-032/043) corrects the cache.

## Using it

| Need | Call |
|---|---|
| UI / resale policy (`InventoryPort`, `src/features/integration/ports.ts`) | `createInventoryPort()`, which has `getAvailability(eventId)` and `getAvailabilityMany(ids)` |
| Resale trigger | `isPrimarySoldOut(db, eventId)`, or `isSoldOut` on the availability |
| Per-tier detail (sold, remaining, pending, cheapest ask) | `getPrimaryAvailability(db, eventId)` → `PrimaryAvailability` (`src/contracts/inventory.ts`) |
| HTTP | `GET /api/events/:id/availability`: public for published events; drafts only for their owner (404 otherwise) |

Agent D's resale policy (XRPL-037) takes the port directly:

```ts
new ResalePolicy({ inventory: createInventoryPort(), events, offers });
```

Agent C's tier views (`soldQuantity`, `remaining` in `src/features/events/event-store.ts`) can read
`getPrimaryAvailabilityMany` instead of their placeholder `0`. For a listing page, it takes all event
IDs in one call.

## Recording confirmed sales (XRPL-032)

`reconcileLedgerTransaction(deps, hash)` in `sales.ts`, also exposed as
**`POST /api/ledger/transactions/:hash/reconcile`** (signed-in callers), applies one **validated**
transaction:

- An `NFTokenAcceptOffer` that consumed one of the app's PRIMARY offers becomes a sale: the offer is
  `ACCEPTED` (`acceptTxHash`, `acceptedByAddress` = the buyer from the validated tx), and the ticket gets
  `primarySoldAt` (ledger close time), `primarySaleTxHash` and its cached owner. It works whether the buyer
  used the app (Agent B's purchase flow, XRPL-031) or another wallet app.
- **Exactly once.** The transaction is claimed in `LedgerTransaction` (unique `hash`, `appliedAt`). If the
  buyer's in-app purchase attempt is still waiting for its hash, that row is used, so the in-app flow then
  sees the sale as applied. Repeated or concurrent calls return `ALREADY_APPLIED` and change nothing.
- Not validated yet → error `LEDGER_TX_NOT_VALIDATED` (409, retry later); nothing is recorded.
- Other transaction types, offers the app didn't create, and resale, private or gift offers return
  `NOT_APPLICABLE`. Ownership after those moves is XRPL-043.

Remaining inventory and the sold-out state come from `primarySoldAt`, so they update as soon as a sale is
recorded, with no separate counter to keep in step.
