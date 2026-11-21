# XRPL_HACKATHON_2026

## Title
Tricket

## DESCRIPTION
NFT ticketing, merchandise and fan-engagement platform on the XRP Ledger (**Testnet only**).
Sellers create events and mint transferable NFT tickets. Buyers purchase with their own wallet, can gift or
resell in-app, and organisers verify current on-chain ownership for one-time entry.

- Architecture, trust boundaries and demo scope: [docs/architecture.md](docs/architecture.md)
- Agent/issue ownership and planned API routes: [docs/CLAUDE_AGENT_HANDOFFS.md](docs/CLAUDE_AGENT_HANDOFFS.md)
- Branch, commit and PR conventions: [CONTRIBUTING.md](CONTRIBUTING.md)
- CI checks, environment variables and deployment steps: [docs/ci-and-deployment.md](docs/ci-and-deployment.md)
- The judge demo, step by step, with fallbacks: [docs/demo/demo-script.md](docs/demo/demo-script.md)
- The story rehearsed on live Testnet, with its transactions: [docs/demo/rehearsal.md](docs/demo/rehearsal.md)

## Team
- XU TAO JUSTIN HE – @XJustinH
- JASON CONBOY     – @conboyj8
- DARRAGH O'TOOLE  – @Nimrod999
- THOMAS SHANAHAN  – @Th0mas-S
- OLIVER WOODS     – @woodsol

## How to run

**Prerequisites:** Node.js 24+, npm, Docker Desktop.

```bash
npm install                 # also generates the Prisma client
cp .env.example .env        # then set SESSION_SECRET (see the comment in the file)
npm run db:up               # Postgres 17 on localhost:5432 (dev + *_test databases)
npm run db:migrate          # apply migrations to the dev database
npm run db:seed             # optional: labelled demo users, events and tiers (docs/seed-data.md)
npm run dev                 # http://localhost:3000
```

Check readiness: `curl http://localhost:3000/api/health` returns
`{"data":{"status":"ok","checks":{"database":"ok"},"xrplNetwork":"testnet",...}}`, or a 503
`SERVICE_UNAVAILABLE` error when the database is down.

Try onboarding at <http://localhost:3000/onboarding>: create a customer or seller profile, or continue as a
seeded demo account. Sellers see **Manage events** in the navigation and customers don't.

Sign in with a wallet at <http://localhost:3000/connect>. This needs `XAMAN_API_KEY` / `XAMAN_API_SECRET` in
`.env` and a Testnet account in the Xaman app. The server verifies the signed Xaman SignIn before linking
the wallet ([docs/auth/wallet-sign-in.md](docs/auth/wallet-sign-in.md)).

### Environment variables

`.env.example` lists every variable with a comment. Copy it to `.env` and fill in what you need:

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | The default matches `docker-compose.yml` |
| `TEST_DATABASE_URL` | `npm run test:db`, `test:testnet`, `test:e2e` | Must be a separate `*_test` database: the tests empty it |
| `SESSION_SECRET` | signing in | At least 32 random characters. Mandatory in production |
| `APP_BASE_URL` | links and cookies | The public https address when deployed |
| `XAMAN_API_KEY`, `XAMAN_API_SECRET` | connecting a wallet and every ledger action | Server-only. Without them the wallet routes answer 503 |
| `XRPL_NETWORK` | choosing the ledger | `testnet` (default) or `devnet`. Anything else is refused at startup |
| `TICKET_METADATA_BASE_URL` | ticket details in wallets and explorers | Must be a public https address wherever tickets are minted for real. It is written into each NFT and can't be changed |
| `DEMO_LOGIN_ENABLED` | the seeded demo accounts | On locally, off in production unless set to `true` |
| `RESALE_MAX_MARKUP_PERCENT` | the optional resale price cap | Unset means no cap ([docs/resale-guardrails.md](docs/resale-guardrails.md)) |

The other XRPL variables override the network's default nodes and are normally left blank
([docs/xrpl/testnet.md](docs/xrpl/testnet.md)).

### Database migrations

- **Development:** `npm run db:migrate` applies the committed migrations to the dev database (and creates
  a new one when `prisma/schema.prisma` has changed).
- **Deployed environments and CI:** `npm run db:deploy` applies committed migrations only. Never run
  `db:migrate` against a deployed database.
- After pulling new migrations, run `npm install` (or `npx prisma generate`) so the generated client
  matches the schema.
- The test database is migrated automatically when the database tests start.

### Wallet setup (XRPL Testnet)

Every ledger action is approved in the user's own [Xaman](https://xaman.app) wallet. The app never asks
for, sees or stores a seed.

1. **Xaman API credentials.** Create an app in the Xaman Developer Console and put its key and secret in
   `.env` as `XAMAN_API_KEY` and `XAMAN_API_SECRET` ([docs/xrpl/wallet.md](docs/xrpl/wallet.md)).
2. **A Testnet account.** `npm run xrpl:dev-wallet -- seller` creates an account and funds it from the
   Testnet faucet. Its seed is saved only to a git-ignored local file
   ([docs/xrpl/testnet.md](docs/xrpl/testnet.md#dev-wallets)).
3. **Xaman on Testnet.** Install Xaman on a phone, import that account (**Add account → Import an existing
   account → Family seed**), and switch the app to **Testnet** in its settings.
4. **Connect.** Open `/connect` in the app, scan the QR code with Xaman and approve. The server checks the
   signature before it trusts the address.
5. `npm run xrpl:check-network` confirms the configured nodes are reachable and on the right network.

A seller and a buyer need separate accounts. Each needs a few XRP: the ledger holds 1 XRP per account and
0.2 XRP for each offer or page of NFTs until they are closed.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (no database needed) |
| `npm run test:db` | Database integration tests against `TEST_DATABASE_URL` (must be a separate `*_test` DB) |
| `npm run test:testnet` | The ticket lifecycle against live XRPL Testnet, with throwaway faucet wallets. On demand, never in CI ([tests/testnet/README.md](tests/testnet/README.md)) |
| `npm run test:e2e` | Browser smoke tests (Playwright) against a production build ([tests/e2e/README.md](tests/e2e/README.md)) |
| `npm run xrpl:check-network` | Checks every configured XRPL node is reachable and on the expected network |
| `npm run xrpl:dev-wallet -- <label>` | Creates and funds a throwaway Testnet wallet for development |
| `npm run db:up` / `db:down` | Start / stop local Postgres |
| `npm run db:migrate` | Create/apply migrations in development (`prisma migrate dev`) |
| `npm run db:deploy` | Apply committed migrations only (deployed environments, CI) |
| `npm run db:seed` | Insert labelled demo users, events and ticket tiers. Idempotent ([docs/seed-data.md](docs/seed-data.md)) |
| `npm run db:studio` | Browse data in Prisma Studio |

### Local vs deployed configuration

- **Local:** `.env` (git-ignored) plus `docker-compose.yml`. The Docker password is a local-only placeholder.
- **Deployed:** the platform injects `DATABASE_URL`, `SESSION_SECRET`, etc. as environment variables.
  Run `npm run db:deploy` (never `migrate dev`) against deployed databases.
  `SESSION_SECRET` (≥ 32 chars) is mandatory when `NODE_ENV=production`.
- `XRPL_NETWORK` accepts only `testnet` or `devnet`. Mainnet is refused at startup.
- `DEMO_LOGIN_ENABLED` lets visitors use seeded demo accounts without a wallet. It defaults to on locally and
  **off in production**, so set it to `true` explicitly for a judges' demo deployment.
- Set `APP_BASE_URL` to the public https URL when deployed. Session cookies are `Secure` only on https.

### Windows note

Run commands from a shell whose working directory uses an **upper-case drive letter**
(`C:\Users\...`, not `c:\Users\...`). With a lower-case drive letter Vitest loads its runner twice and every
suite fails with `Cannot read properties of undefined (reading 'config')`. Some VS Code terminals open
with a lower-case drive letter, and running `cd C:\path\to\repo` first fixes it.

### NixOS note

`prisma generate` (run by `npm install`) can fail on NixOS because there is no prebuilt engine for the
`linux-nixos` platform. A teammate reported this workaround:

```bash
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x npx prisma generate
```

## How it works

The XRP Ledger is the source of truth for which NFTs exist and who holds them. The database holds
everything else (events, accounts, check-in records) and a cache of ledger state that is refreshed from
validated ledgers. Nothing is shown as done until the ledger has validated it with `tesSUCCESS`.

| Part | In short | Details |
|---|---|---|
| **Ticket NFTs and metadata** | One transferable NFT per ticket, minted by the seller's own wallet. Its URI points at JSON served by the app (event, ticket type, serial, artwork). The taxon groups a seller's tickets by event, and a memo on the mint carries the ticket's ID, so the mapping can be rebuilt from the ledger | [docs/xrpl/ticket-nft.md](docs/xrpl/ticket-nft.md) |
| **Offers and purchases** | The seller lists a ticket with an `NFTokenCreateOffer`. The buyer accepts it with an `NFTokenAcceptOffer`, and the ledger swaps the NFT and the XRP in one transaction. The offer is re-checked on the ledger before the buyer is asked to pay, and one buyer at a time can hold a ticket | [docs/xrpl/offers.md](docs/xrpl/offers.md) |
| **Resale, private sale, gift** | A holder offers their ticket on: publicly, or to one named wallet (a zero price is a gift). Offers can be cancelled, and ones the ledger no longer backs are closed | [docs/xrpl/offers.md](docs/xrpl/offers.md#holder-offers-resale-private-sale-gift-xrpl-036-039-040-041) |
| **Ownership** | My tickets and the door read the holder from a validated ledger. Moves made with other wallet apps are picked up when a ticket is checked against the ledger | [docs/xrpl/ownership.md](docs/xrpl/ownership.md) |
| **Check-in** | The holder gets a short-lived code and proves control of the wallet by signing in Xaman. The organiser's scan reads the current owner from the ledger and records one admission per ticket. The check-in itself is a database record, not a ledger transaction | [docs/checkin-and-resale-contract.md](docs/checkin-and-resale-contract.md) |
| **Wallet approvals** | Every transaction is built on the server, approved in the user's Xaman app, and followed to a validated ledger | [docs/xrpl/wallet.md](docs/xrpl/wallet.md) |

## Known restrictions

- **The sold-out resale rule is app-side, not enforced by the XRP Ledger.** This app lists a resale
  ticket only after the event's primary sale has sold out. Tickets are transferable NFTs, so a holder can
  still sell or give one away on the ledger with any wallet app, at any time and price. The same goes for
  the optional resale price cap ([docs/resale-guardrails.md](docs/resale-guardrails.md)).
- **Testnet only.** `XRPL_NETWORK` accepts `testnet` or `devnet`, and every node must report the matching
  network before it is used. No real money moves. The Testnet is reset from time to time, which deletes
  accounts and NFTs.
- **One wallet approval per action.** Each mint, listing, purchase and transfer is its own approval in
  Xaman. Minting a whole ticket type is a run of approvals.
- **Each offer and page of NFTs locks 0.2 XRP** of its owner's balance until it is closed. The app checks
  a wallet can cover this before asking it to sign.
- **A ticket moved outside the app** shows its new owner in the app once it is checked against the ledger,
  not instantly. The door always reads the ledger.
- **Ticket details follow later edits.** The metadata is rendered from the current event record, so
  editing an event after minting changes what wallets and explorers show.
- **Buying an NFT doesn't transfer copyright** in any artwork or media.
- **Payments for physical merchandise are simulated.** No card details are collected.
- **Accounts and sessions are for a prototype:** the seeded demo accounts sign in without a password
  when `DEMO_LOGIN_ENABLED` is on.

What is live, simulated and deferred is listed in
[docs/architecture.md](docs/architecture.md#7-live-vs-simulated-vs-deferred) and, for the demo, in
[docs/demo/demo-script.md](docs/demo/demo-script.md#what-is-confirmed-simulated-or-deferred).

## Project structure

```text
src/
  app/                  Next.js pages and API route handlers (src/app/api/**/route.ts) (C owns the shell)
  components/           Shared UI components, Tailwind (C)
  contracts/            Zod schemas + shared DTO types, safe for client and server (A approves exports)
  lib/env.ts            Validated server-only environment (A)
  lib/http/             Response envelope, error mapping, body parsing (A)
  lib/db/               Prisma client, DTO mappers, repositories, reconciliation (A)
  lib/auth/             Sessions, wallet-control proof, role checks (A)
  lib/xrpl/             XRPL client, signer adapter, transaction builders (B)
  lib/resale-policy/    In-app resale publication policy (D)
  features/integration/ Typed ports the UI depends on; stubs until real services land (C)
  features/events/      Event CRUD, discovery, ticket UI (C)
  features/checkin/     Check-in challenge, verification, admission (D)
  features/commerce/    Merchandise and digital collectibles (E)
  features/community/   Posts, likes, comments, notifications (E)
  generated/            Prisma client output (git-ignored)
prisma/                 Schema + migrations (A only)
docker/                 Local Postgres init scripts
docs/                   Architecture decision records and feature docs
```

## How we work
- Never push directly to `main`; use a branch and open a pull request.
- One branch per issue with a descriptive name, e.g. `feat/xrpl-005-core-ticketing-schema` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- Never commit API keys, wallet seeds or passwords.
