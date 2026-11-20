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
| `DATABASE_URL_UNPOOLED` | Vercel build only | **Yes** | Direct (non-pooled) connection string, used for migrations and the seed. Set by the Neon integration. |
| `SEED_DEMO_DATA` | Vercel build only | No | `true` makes each build insert the labelled demo data (idempotent). |
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

## Preview deployment (Vercel + Neon)

**Preview URL:** not live yet. It needs the one-time setup below, which only the repository owner can do.
This section will record the production URL once it exists.

Once connected, Vercel builds every pull request and posts its own preview URL on the PR, and every push to
`main` updates the production URL. Neon gives each preview its own copy of the database (a branch of the
default database), so a PR's migrations can't break other previews.

### What the repository already does

- [`vercel.json`](../vercel.json) sets the install command (`npm ci`) and the build command.
- [`scripts/deploy/vercel-build.sh`](../scripts/deploy/vercel-build.sh) runs on every deployment:
  1. checks the environment variables and fails the build with the variable's name if one is missing or
     invalid ([`check-env.ts`](../scripts/deploy/check-env.ts))
  2. applies committed migrations over the direct connection (`DATABASE_URL_UNPOOLED`)
  3. inserts the demo data when `SEED_DEMO_DATA=true`
  4. builds the app

### One-time setup (repository owner)

Importing the repository installs Vercel's GitHub app on it, which needs admin rights on the repo.

1. **Create the project.** In Vercel, add a new project and import this repository. Leave the build and
   install commands as detected, because `vercel.json` sets them. Under Project Settings → Build and
   Deployment, set the Node.js version to 24.x.
2. **Add the database.** Add the Neon Postgres integration to the project (Storage or Integrations), connect it
   to the Production and Preview environments, and turn on a database branch for each preview deployment.
   Keep the default variable names: the build script expects `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
3. **Set the variables** (Project Settings → Environment Variables):

   | Variable | Production | Preview |
   |---|---|---|
   | `SESSION_SECRET` | New random value, 32+ characters | A different random value, 32+ characters |
   | `XRPL_NETWORK` | `testnet` | `testnet` |
   | `DEMO_LOGIN_ENABLED` | `true` only for the judges' demo | `true` |
   | `SEED_DEMO_DATA` | `true` only for the judges' demo | `true` |
   | `APP_BASE_URL` | The production `https` URL | Leave unset |

   Previews need `SESSION_SECRET` too: Vercel runs previews in production mode, and the app refuses to start
   without it. A missing value fails the build with a message naming the variable.
4. **Decide who can open previews.** New Vercel projects require a Vercel login for preview URLs. To let
   teammates without Vercel access (or judges) open them, add those people to the Vercel team, or turn off
   Vercel Authentication for previews under Project Settings → Deployment Protection.
5. **Check it works.** Open a pull request. Vercel comments with the preview URL, and `<preview URL>/api/health`
   should return 200 with `"database":"ok"`.

### Limitations

- Without `APP_BASE_URL`, preview session cookies aren't marked `Secure`. They still work over `https`.
- The XRPL read service keeps WebSocket connections to Testnet. Serverless functions reopen them after being
  idle, so the first ledger read on a cold preview can be slower.
- Migrations run at build time. If a build fails after migrating, the database is already on the new schema
  while the previous version keeps serving.
