# Demo seed data (XRPL-008)

`npm run db:seed` loads a small set of clearly labelled demo users, events and ticket tiers, so the UI
has something to show before the ledger flows land. It is safe to run any number of times.

```bash
npm run db:up        # local Postgres
npm run db:migrate   # apply migrations
npm run db:seed      # insert demo data (prints what was created vs already present)
```

## What gets seeded

| Kind | Fixed ID (`DEMO_IDS`) | Record |
|---|---|---|
| Seller (artist) | `users.artistSeller` | `[DEMO] The Testnet Tones` |
| Seller (venue) | `users.venueSeller` | `[DEMO] The Ledger Rooms` |
| Organiser | `users.organiser` | `[DEMO] Door Team` |
| Customer | `users.customer` | `[DEMO] Alex Fan` (buyer) |
| Customer | `users.secondCustomer` | `[DEMO] Sam Friend` (gift / private-sale / resale recipient) |
| Event, published | `events.headlineShow` | The Testnet Tones live in Dublin, 12 Mar 2027. Tiers: General Admission 2.5 XRP × 3, VIP 10 XRP × 1 |
| Event, published | `events.openMicNight` | Open mic night hosted by the venue seller, Dublin, 2 Apr 2027. Tier: Standard 1 XRP × 10 |
| Event, draft | `events.corkDraft` | Unpublished Cork date for the artist's seller dashboard. Tier: General Admission 3 XRP × 5 |

Tier supplies are small on purpose. The headline show can sell out during a live demo, and selling out
is what unlocks in-app resale (XRPL-037). Prices are stored as integer drops (1 XRP = 1,000,000 drops).
Event dates are fixed in 2027 so the published events stay upcoming throughout the hackathon.

All IDs start with `5eed0000-`. Tests and demo scripts should import them rather than copy them:

```ts
import { DEMO_IDS } from "../scripts/seed/fixtures"; // path relative to your file
```

## What is deliberately not seeded

- **Wallet links.** A stored address proves nothing. Wallet control is established only by a
  wallet-signed challenge (XRPL-012), so demo wallets are connected live.
- **Ticket NFTs, offers and ledger transactions.** These must come from validated XRPL Testnet
  transactions. Seeding them would show fake on-chain activity as real.

## How demo content is labelled

- User display names and event titles start with `[DEMO]`.
- Event descriptions start with a notice that the event is not real and its tickets have no monetary
  value. Venue names end in `(demo venue)`, and tier descriptions say "Demo tier".
- Demo users have `settings.demo = true`, so code can detect them without matching on names.

## Behaviour on re-run

- **Create-only.** Missing records are inserted. Records that already exist (matched by ID) are left
  as the app left them, so a re-run never resets inventory, publication state or demo edits.
- **Additive.** Only the fixture IDs are touched. Nothing else is changed or deleted.
- **Atomic.** One transaction, so a failed run leaves no partial demo data.
- **Safe to run concurrently.** Inserts use `ON CONFLICT DO NOTHING`.
- If another record blocks a fixture, for example a tier with the same name on a demo event under a
  different ID, the run fails with a `SeedConflictError` that names the blocked IDs and writes nothing.

To get the demo records back to their original state, reset the local database and seed again.
`npx prisma migrate reset` **deletes all data** in the database named by `DATABASE_URL`:

```bash
npx prisma migrate reset && npm run db:seed
```

## Safety

- The seed refuses to run when `NODE_ENV=production`. For a demo or preview database, pass the flag
  explicitly: `npm run db:seed -- --allow-production`.
- Output shows only the database name, never the connection string.

## Files

| File | Purpose |
|---|---|
| `scripts/seed/fixtures.ts` | Demo records and `DEMO_IDS`. Pure data, importable from tests |
| `scripts/seed/seed-demo-data.ts` | `seedDemoData(db)`: idempotent, transactional insert |
| `scripts/seed/run.ts` | CLI entry point behind `npm run db:seed` |
| `tests/seed/fixtures.test.ts` | Unit checks: IDs, labels, contract-valid roles, statuses and prices |
| `tests/seed/seed-demo-data.int.test.ts` | DB checks: idempotency, overlapping runs, create-only, rollback on conflict |
