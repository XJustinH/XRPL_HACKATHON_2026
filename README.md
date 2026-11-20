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
npm run dev                 # http://localhost:3000
```

Check readiness: `curl http://localhost:3000/api/health` returns
`{"data":{"status":"ok","checks":{"database":"ok"},"xrplNetwork":"testnet",...}}`, or a 503
`SERVICE_UNAVAILABLE` error when the database is down.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server |
| `npm run typecheck` | Generate route types and run `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (no database needed) |
| `npm run test:db` | Schema integration tests against `TEST_DATABASE_URL` (must be a separate `*_test` DB) |
| `npm run db:up` / `db:down` | Start / stop local Postgres |
| `npm run db:migrate` | Create/apply migrations in development (`prisma migrate dev`) |
| `npm run db:deploy` | Apply committed migrations only (deployed environments, CI) |
| `npm run db:studio` | Browse data in Prisma Studio |

### Local vs deployed configuration

- **Local:** `.env` (git-ignored) plus `docker-compose.yml`. The Docker password is a local-only placeholder.
- **Deployed:** the platform injects `DATABASE_URL`, `SESSION_SECRET`, etc. as environment variables.
  Run `npm run db:deploy` (never `migrate dev`) against deployed databases.
  `SESSION_SECRET` (≥ 32 chars) is mandatory when `NODE_ENV=production`.
- `XRPL_NETWORK` accepts only `testnet` or `devnet`. Mainnet is refused at startup.

### Windows note

Run commands from a shell whose working directory uses an **upper-case drive letter**
(`C:\Users\...`, not `c:\Users\...`). With a lower-case drive letter Vitest loads its runner twice and every
suite fails with `Cannot read properties of undefined (reading 'config')`. Some VS Code terminals open
with a lower-case drive letter, and running `cd C:\path\to\repo` first fixes it.

## Project structure

```text
src/
  app/                  Next.js pages and API route handlers (src/app/api/**/route.ts)
  contracts/            Zod schemas + shared DTO types, safe for client and server (A approves exports)
  lib/env.ts            Validated server-only environment (A)
  lib/http/             Response envelope, error mapping, body parsing (A)
  lib/db/               Prisma client, DTO mappers, repositories, reconciliation (A)
  lib/auth/             Sessions, wallet-control proof, role checks (A)
  lib/xrpl/             XRPL client, signer adapter, transaction builders (B)
  lib/resale-policy/    In-app resale publication policy (D)
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
