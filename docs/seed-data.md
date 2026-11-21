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
| Seller (artist) | `users.artistSeller` | `The Testnet Tones` |
| Seller (venue) | `users.venueSeller` | `The Ledger Rooms` |
| Organiser | `users.organiser` | `Door Team` |
| Customer | `users.customer` | `Alex Fan` (buyer) |
| Customer | `users.secondCustomer` | `Sam Friend` (gift / private-sale / resale recipient) |
| Event, published | `events.headlineShow` | The Testnet Tones live in Dublin, 12 Mar 2027. Tiers: General Admission 2.5 XRP × 3, VIP 10 XRP × 1 |
| Event, published | `events.openMicNight` | Open mic night hosted by the venue seller, Dublin, 2 Apr 2027. Tier: Standard 1 XRP × 10 |
| Event, draft | `events.corkDraft` | Unpublished Cork date for the artist's seller dashboard. Tier: General Admission 3 XRP × 5 |
| Event, published | `events.warehouseParty` | Late-night club event, Dublin, 20 Mar 2027. Tier: Entry 1.5 XRP × 8 |
| Event, published | `events.djAllNighter` | Club night with resident DJs, Dublin, 10 Apr 2027. Tier: Entry 2 XRP × 6 |
| Event, published | `events.neonClubNight` | Weekly club night, Galway, 23 Apr 2027. Tier: Entry 0.8 XRP × 4 |
| Event, published | `events.ledgerTalks` | Evening of talks, Dublin, 14 May 2027. Tier: Seat 0.5 XRP × 10 |
| Event, published | `events.summerFestival` | One-day festival, Cork, 17 Jul 2027. Tier: Day Ticket 4.5 XRP × 12 |

Every event carries artwork, as a URL on Unsplash's CDN rather than a file in the repository. The
cards render it with a plain `img` that hides a broken link, so a dead URL costs a placeholder
rather than an error. The events span several categories so the category filter has something to
filter (XRPL-059).

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

- Display names and event titles are **not** labelled: they are what the audience reads during the
  demo. A database seeded before this changed is renamed on the next run (see below).
- Event descriptions start with a notice that the event is not real and its tickets have no monetary
  value. Venue names end in `(demo venue)`, and tier descriptions say "Demo tier".
- Demo users have `User.isDemo = true`. Code should detect demo accounts with this flag, not by name.
  It is also what lets demo login offer them as personas when `DEMO_LOGIN_ENABLED` is on
  (see [src/lib/auth/README.md](../src/lib/auth/README.md)). Users seeded before the column existed
  carry `settings.demo = true`, which the backfill migration converted. New seeds no longer write it.

## Behaviour on re-run

- **Create-only.** Missing records are inserted. Records that already exist (matched by ID) are left
  as the app left them, so a re-run never resets inventory, publication state or demo edits.
- **Except `isDemo`.** It is set back to `true` on the five demo users on every run, because a demo user
  without it silently drops out of demo login. The seed output says when it restored any.
- **Except names still carrying `[DEMO] `.** Rows seeded before the prefix was dropped are renamed,
  since create-only would otherwise keep the old names for good. Only the exact previous labelled
  value is matched, so a name edited since is left alone, and an event with minted tickets keeps its
  title: that title is already in its tickets' NFT metadata on the ledger.
- **Except empty categories and artwork.** Both are filled in where still null, so events seeded
  before those columns existed gain them without overwriting anything set since.
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
| `tests/seed/seed-demo-data.int.test.ts` | DB checks: idempotency, overlapping runs, create-only, demo personas and `isDemo` restore, rollback on conflict |
