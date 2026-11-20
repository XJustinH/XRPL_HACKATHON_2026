# CI, environment variables and deployment (XRPL-009)

## Continuous integration

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It runs on every pull request and on
every push to `main`. A new push to the same PR cancels the outdated run.

| Job | What it runs |
|---|---|
| **Typecheck, lint, unit tests, build** | `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` |
| **Database tests and demo seed** | Starts Postgres 17, creates the `*_test` database with the same init script as `docker-compose.yml`, runs `npm run test:db`, then `npm run db:deploy` and `npm run db:seed` twice to check that the seed is idempotent |

- **No secrets.** Tests use fakes for the ledger and the wallet provider, and the database is a throwaway
  container inside the job. The workflow token is read-only.
- **Node 24**, matching the README prerequisites.
- **Not run in CI:** tools that need the public XRPL Testnet, such as checking the network or creating faucet
  wallets. A slow or unavailable public node would make every PR fail for reasons unrelated to the change.
- `npm ci` prints `npm warn install-scripts` lines on npm 11 and later. They are expected. The steps above
  pass without those dependency install scripts.

**Reproduce CI locally** (needs `npm run db:up`):

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run test:db
npm run db:deploy && npm run db:seed
```

**Making CI block merges** is a repository setting only an admin can change: add both checks as required
status checks for `main` (Settings → Rules or Branches).

## Environment variables

[`.env.example`](../.env.example) is the source of truth for names and defaults. Locally, copy it to `.env`
(git-ignored). Deployed environments set the values in the hosting platform's settings, never in the repository.

| Variable | Used by | Secret | Notes |
|---|---|---|---|
| `DATABASE_URL` | App, migrations, seed | **Yes** in deployed environments | Postgres 17 connection string. It contains the password. |
| `TEST_DATABASE_URL` | `npm run test:db` only | No (local and CI only) | Must name a separate database ending in `_test`. Tests wipe it. |
| `APP_BASE_URL` | App | No | Public origin of the deployment. An `https` URL turns on `Secure` session cookies. |
| `SESSION_SECRET` | App | **Yes** | At least 32 random characters. Required when `NODE_ENV=production`. Use a different value per environment. |
| `DEMO_LOGIN_ENABLED` | App | No | Lets visitors use seeded demo accounts without a wallet. On by default locally, **off by default in production**. Set `true` only on a demo deployment. |
| `NEXT_PUBLIC_XRPL_NETWORK_LABEL` | UI | No | Shipped to the browser, so it must never hold a secret. |
| `XRPL_NETWORK` | App | No | `testnet` (default) or `devnet`. Mainnet is refused. Other `XRPL_*` variables are optional overrides with Testnet defaults (see the XRPL section of `.env.example`). |
| `XAMAN_API_KEY`, `XAMAN_API_SECRET` | Wallet signing | **Yes** (the secret) | Needed once wallet sign-in and signing land (XRPL-011/014). |
| `STORAGE_*`, `PUBLIC_ASSET_BASE_URL` | Ticket metadata and media | **Yes** (access keys) | Needed once metadata hosting and uploads land (XRPL-023, XRPL-070). |
| `STRIPE_*`, `SPOTIFY_*`, `NOTIFICATION_PROVIDER_API_KEY` | Optional integrations | **Yes** | Leave blank unless an integration is explicitly enabled. |

Secrets are read on the server only. Never give a secret a `NEXT_PUBLIC_` prefix, which would ship it to
every browser. CI sets only `DATABASE_URL` and `TEST_DATABASE_URL`, both pointing at its throwaway container.

## Deploying

These steps work on any host that runs Node.js and can reach a Postgres 17 database.

1. **Database:** create a Postgres 17 database and store its connection string as `DATABASE_URL`.
2. **Settings:** in the host's environment settings, set at least `DATABASE_URL`, `APP_BASE_URL` (the
   deployment's own `https` URL), `SESSION_SECRET` (a new random value) and `XRPL_NETWORK=testnet`.
   Set `DEMO_LOGIN_ENABLED=true` only if this deployment should offer demo accounts.
3. **Build** with Node 24: `npm ci && npm run build`.
4. **Migrate** before starting each new version: `npm run db:deploy`. It applies committed migrations only.
   Never run `npm run db:migrate` against a deployed database.
5. **Demo data (optional):** `npm run db:seed -- --allow-production`. The flag is needed because hosts run
   with `NODE_ENV=production`.
6. **Start:** `npm start`. It listens on the `PORT` environment variable (default 3000).
7. **Check:** `GET /api/health` returns 200 with `"database":"ok"`.

## Preview deployment

Not set up yet: the hosting platform hasn't been chosen. Once it is, this section will record the preview URL,
how pull request previews are created, and who manages the platform settings.
