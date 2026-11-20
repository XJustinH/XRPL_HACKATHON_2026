# Check-in and resale policy contract (Agent D)

Covers XRPL-044, 045, 046, 047 (check-in) and XRPL-037 (in-app resale policy).
Status: **core logic, Prisma store and tests done. Route handlers wait on wallet auth (XRPL-012),
roles (XRPL-013) and Agent B's ledger reads (XRPL-028).**

| File | What it is |
|---|---|
| [`src/contracts/checkin.ts`](../src/contracts/checkin.ts) | Request schemas, result types, HTTP mapping, limitation notice |
| [`src/features/checkin/checkin-service.ts`](../src/features/checkin/checkin-service.ts) | Challenge, proof, verify and atomic admit |
| [`src/features/checkin/prisma-store.ts`](../src/features/checkin/prisma-store.ts) | `CheckInStore` / `TicketDirectory` on the XRPL-005 schema |
| [`src/features/checkin/ports.ts`](../src/features/checkin/ports.ts) | Interfaces other agents implement |
| [`src/lib/resale-policy/resale-policy.ts`](../src/lib/resale-policy/resale-policy.ts) | `ResalePolicyPort` implementation |

Tests: `npm test` (unit, in-memory fakes) and `npm run test:db` (Prisma store against Postgres).

## Check-in flow

```mermaid
sequenceDiagram
  participant A as Attendee app
  participant API as Backend (Agent D)
  participant W as Attendee wallet
  participant O as Organiser scanner
  participant L as XRPL (Agent B)
  A->>API: POST /api/checkin/challenges {ticketId}
  API->>L: getOwner(nftokenId) == session wallet?
  API-->>A: qrPayload, messageToSign, expiresAt (2 min)
  A->>W: sign messageToSign
  A->>API: POST /api/checkin/challenges/:id/prove {proof}
  O->>API: POST /api/checkin/verify {qrPayload, eventId}
  API->>L: getOwner(nftokenId)
  API-->>O: VERIFIED or reason (read-only)
  O->>API: POST /api/checkin/confirm {qrPayload, eventId}
  API->>L: getOwner(nftokenId) again
  API-->>O: ADMITTED once, otherwise ALREADY_USED
```

**QR payload:** `xtc1.<challengeId>.<hmacTag>`. The tag is HMAC-SHA256 with `CHECKIN_QR_SECRET`
over the challenge ID, event, ticket and expiry. The QR holds no wallet address, seed, name or contact
details. A tampered or forged QR, or one from another server, returns `INVALID_QR`.

**Why a screenshot does not work:** a challenge is only usable after the wallet holding the NFT
signs `messageToSign`. That text contains a random nonce, the challenge ID, event, NFT ID and expiry.
A proof from another wallet, for another challenge, sent twice or sent after expiry is rejected. At
the gate the ledger owner is read again, so a ticket transferred away after the proof gets `WRONG_OWNER`.

**One entry only:** `admitAtomically` runs one transaction. It consumes the challenge only
`WHERE consumedAt IS NULL`, then inserts `CheckInRecord`, which is unique on `(ticketId, eventId)`.
A second scan with the same challenge, or with another challenge for the same ticket, gets
`ALREADY_USED`.

### Results

Failures use the standard envelope `{ error: { code: <status>, message }, requestId }`.

| Status | HTTP | Meaning |
|---|---:|---|
| `INVALID_QR` | 400 | Malformed or tampered code |
| `INVALID_PROOF` | 401 | Bad, replayed or wrong-wallet proof |
| `NOT_AUTHORISED` | 403 | Scanner is not an organiser for this event |
| `WRONG_EVENT` | 403 | Ticket is for another event |
| `WRONG_OWNER` | 403 | Wallet no longer holds the NFT |
| `UNKNOWN_TICKET` | 404 | Ticket not found, not minted, or NFT gone |
| `PROOF_REQUIRED` | 409 | Attendee has not approved in their wallet yet |
| `ALREADY_USED` | 409 | Ticket already checked in |
| `EXPIRED` | 410 | Challenge expired; attendee refreshes |
| `LEDGER_UNAVAILABLE` | 503 | XRPL unreachable; **never admit** |

## Resale policy (XRPL-037)

`ResalePolicy` implements `ResalePolicyPort` from `src/features/integration/ports.ts` and returns
`ResaleEligibility` from `src/contracts/events.ts`.

| `reasonCode` | When |
|---|---|
| `EVENT_NOT_PUBLISHED` | Event missing or still a draft |
| `EVENT_FINISHED` | `endsAt` (or `startsAt` when there is no end time) has passed |
| `PRIMARY_STILL_ON_SALE` | Any primary ticket left, or availability is inconsistent |
| `PRIMARY_SOLD_OUT` | `totalSupply > 0`, `remaining === 0` and `isSoldOut`: **resale allowed** |

- `listPublicOffers(eventId)` returns nothing unless eligible. It also keeps only `kind = RESALE`,
  `state = ACTIVE` offers for that event from `OfferPort.listResaleOffers`.
- `getPublicOffer(eventId, offerId)` is the guard for single-offer reads **and for Agent B's resale
  accept-intent route**, so a direct API call cannot reach a hidden listing.
- If inventory or offers cannot be read, the error propagates (503) and nothing is listed.
- Every eligibility `message` that mentions resale includes `RESALE_LIMITATION_NOTICE`. The UI must
  show it: the rule is app-only and does not stop transfers made directly on XRPL.

## What D still needs

| From | What | Used by |
|---|---|---|
| A (XRPL-012) | Session with a **verified** wallet address | `issueChallenge` (never from the request body) |
| A/B (XRPL-012) | `WalletProofVerifier.verify(message, proof)`, e.g. Xaman SignIn | `proveControl` |
| A (XRPL-013) | `OrganiserAccess.canScanEvent(userId, eventId)` | Scanner routes |
| B (XRPL-028) | `LedgerOwnership.getOwner` from a validated ledger; throw `LedgerUnavailableError` on failure | Gate checks |
| A (XRPL-020) | Real `InventoryPort.getAvailability` | Resale policy |
| B (XRPL-036) | Real `OfferPort.listResaleOffers` (live offers only) | Resale listings |
| C (XRPL-034) | Ticket view renders `qrPayload` as a QR with an "Approve in wallet" step, refreshing at `expiresAt` | Attendee side |
| A (env) | Add `CHECKIN_QR_SECRET` (server-only, 32+ chars) to `src/lib/env.ts` and `.env.example` | QR tags |

Next for Agent D: route handlers for §5.4, the organiser scanner UI (XRPL-048) and the
edge-case suite (XRPL-049).
