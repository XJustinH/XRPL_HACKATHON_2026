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
| Resale page | The resale page, an event page and the resale page filtered to that event explain that listings appear only once an event sells out (the seed has none) |

## Phone-size and accessibility checks (XRPL-051)

`mobile-accessibility.spec.ts` runs the four screens people use at an event at three phone sizes
(360 x 640, 390 x 844 and 412 x 915) with touch input, so every step is a tap and nothing can depend on
hover.

| Test | Flow |
|---|---|
| Seller event creation | Create a draft, add a tier and publish, by touch |
| Form errors | An end time before the start is refused in words, tied to its field (`aria-describedby`) |
| Buyer checkout | Open the event, pick a ticket, review the order, and reach the connect-wallet step |
| My Tickets | What it says to a visitor, and to an account with no wallet |
| Door scanner | Type a code, see a valid ticket, admit it, then see a second scan refused |
| Other screens | 16 more pages a visitor, a customer and a seller reach |
| Browser controls | The page tells the browser which colours it uses, so date pickers and menus match it |
| Main menu | Opens by touch and by keyboard, closes on Escape and returns focus |

At each step three things are checked:

- **Nothing is wider than the phone.** Measured against the phone's own width, because a phone browser
  widens its viewport to fit oversized content.
- **No axe violations of WCAG 2.2 A or AA** (`@axe-core/playwright`): names and labels, contrast, target
  size, ARIA use.
- **Keyboard focus is visible**, where checked: every Tab stop shows a focus ring that is not cut off.

What they don't cover:

- **Wallet steps** (connecting Xaman, approving a purchase or a check-in), and screens that read the
  ledger: the ticket list itself, a ticket's page and its door code.
- **The scanner's two API calls are answered by the test**, because a real check-in needs a ticket on
  the ledger. The camera is not exercised; the code is typed, as a handheld scanner would.
- **A real phone and a screen reader.** These are emulated sizes in Chromium, not devices.

The checkout test needs a ticket to sell, and the organiser's check-in chart needs a check-in to draw. The
demo seed has neither, because tickets must come from validated ledger transactions. `ticket-fixtures.ts`
adds one listed ticket and one checked-in ticket to the `*_test` database only.

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
