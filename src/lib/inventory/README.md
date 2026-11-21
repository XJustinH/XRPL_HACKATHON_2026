# src/lib/inventory — Agent A

Primary inventory and sell-out state (XRPL-020). Recording sales from their validated transactions
(XRPL-032) and keeping ownership in step with the ledger (XRPL-043) live in [`src/lib/ownership`](../ownership/README.md).

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

See [`src/lib/ownership`](../ownership/README.md). A primary sale recorded there sets `primarySoldAt`, which is
all this module counts. Remaining inventory and the sold-out state come from it, so they update as soon as a
sale is recorded, with no separate counter to keep in step.
