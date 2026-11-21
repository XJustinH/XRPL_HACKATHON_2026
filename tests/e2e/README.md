# Browser smoke tests of the demo path

Playwright tests that click through the parts of the demo that need no wallet, in a real browser against a
production build with the demo seed.

```bash
npm run db:up                         # Postgres, if it isn't running
npx playwright install chromium       # once per machine
npm run test:e2e                      # builds the app, then about a minute of tests
```

CI runs them on every pull request (the **Browser smoke tests** job). On failure, CI keeps the HTML report,
screenshots and traces as the `playwright-report` artifact (`npx playwright show-report` to open it locally).

## What they check

| Test | Flow |
|---|---|
| Visitor | The homepage lists the published demo events and hides the draft |
| Customer | A customer account can't create events |
| Seller | Sign in as the demo artist, create an event, add a tier, publish, then find it on the homepage |
| Storefront | A seller's public page shows their published events and not their draft |
| Publish refresh | Publishing is possible right after adding a tier, without a reload |

## How they run

- `playwright.config.ts` builds the app and starts it on port 3100 against `TEST_DATABASE_URL`, with demo
  sign-in on.
- `global-setup.ts` and `prepare-db.ts` migrate that `*_test` database, empty it and insert the demo seed, so
  every run starts from the same data. It is the same database `npm run test:db` uses, so don't run both at
  once.
- Elements are found by what a person sees (labels, buttons, headings), so styling changes don't break the
  tests. Renaming a label or button does: update the test with it.
- Wallet steps (connecting Xaman, minting, buying) need a person approving on a phone and are not covered.
  The ledger side of those flows is checked by the live Testnet suite (`tests/testnet/`).
