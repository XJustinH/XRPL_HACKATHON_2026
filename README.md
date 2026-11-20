# XRPL_HACKATHON_2026

## Title
To be decided

## DESCRIPTION
NFT ticketing, merchandise and fan-engagement platform on the XRP Ledger (**Testnet only**).
Sellers create events and mint transferable NFT tickets. Buyers purchase with their own wallet, can gift or
resell in-app, and organisers verify current on-chain ownership for one-time entry.

- Architecture, trust boundaries and demo scope: [docs/architecture.md](docs/architecture.md)
- Agent/issue ownership and planned API routes: [docs/CLAUDE_AGENT_HANDOFFS.md](docs/CLAUDE_AGENT_HANDOFFS.md)
- Branch, commit and PR conventions: [CONTRIBUTING.md](CONTRIBUTING.md)

## Team
- XU TAO JUSTIN HE – @XJustinH
- JASON CONBOY     – @conboyj8
- DARRAGH O'TOOLE  – @Nimrod999
- THOMAS SHANAHAN  – @ThOmas-S
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
seeded demo account. Sellers see **Manage events** in the navigation and customers don't. Wallet sign-in
comes later (XRPL-012); until then profiles are not linked to a wallet and cannot sign transactions.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (no database needed) |
| `npm run test:db` | Database integration tests (schema, auth/onboarding) against `TEST_DATABASE_URL` (must be a separate `*_test` DB) |
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
