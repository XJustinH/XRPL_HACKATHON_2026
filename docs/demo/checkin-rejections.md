# Demo: check-in rejects a duplicate scan (XRPL-049)

About 60 seconds. Shows that a ticket gets in once, and that a copy of the code doesn't.

## Before the demo

- Two phones, or one phone plus a laptop:
  - **Organiser:** signed in as the event's seller, on `/organiser/events/<eventId>/checkin`
  - **Attendee:** signed in with a verified wallet that holds a ticket for that event
- XRPL Testnet reachable (`npm run xrpl:check-network` → OK).
- **Wallet approval (XRPL-012) must be live.** Until it is, the attendee's approve step returns 503, so use the recorded fallback below.

## Script

1. **Attendee** opens the ticket and taps "Show check-in code". A QR appears that expires in 2 minutes.
   > "The code is only valid for two minutes and only for this event. It contains no wallet address or personal data."
2. **Attendee** approves the check-in in their wallet.
   > "A screenshot isn't enough: the wallet that holds the ticket NFT has to sign for this exact code."
3. **Organiser** scans. It shows green **Valid ticket**, read live from the XRP Ledger. Tap **Admit**, and it shows **Admitted**.
4. **Organiser** scans the **same code again** (or a screenshot of it). It shows red **Already checked in: do not admit**.
   > "The database admits a ticket once per event, even if two staff scan at the same moment."
5. Point at **Entry so far**: the count went up by one, not two.

Optional extras if there is time:
- Wait 2 minutes and scan a fresh, unapproved code. It shows **Code expired**.
- Transfer the NFT to another wallet in Xaman, then scan. It shows **Ticket not held by this wallet**.

## Fallback (no live wallet approval)

Run the automated suite and show the output. It covers the same cases through the real routes and database:

```bash
npm run db:up
npm run test:db -- src/features/checkin/checkin-edge-cases.int.test.ts
```

| Case | Result | Attendance record |
|---|---|---|
| Duplicate scan | 409 `ALREADY_USED` | still 1 |
| Two codes, same ticket, scanned at once | one 201, one 409 | 1 |
| Someone else's wallet asks for or approves a code | 403 `WRONG_OWNER` / 401 `INVALID_PROOF` | 0 |
| Code never approved in the wallet | 409 `PROOF_REQUIRED` | 0 |
| Wrong event's gate | 403 `WRONG_EVENT` | 0 |
| Not the event's organiser | 403 `NOT_AUTHORISED` | 0 |
| Expired code | 410 `EXPIRED` | 0 |
| NFT transferred away on XRPL | 403 `WRONG_OWNER` | 0 |
| XRPL unreachable | 503 `LEDGER_UNAVAILABLE` | 0 |
| Tampered code, cross-site request | 400 `INVALID_QR`, 403 | 0 |

The ledger and wallet signature are simulated in that suite. Everything else (routes, sessions, Postgres, unique index) is real.
