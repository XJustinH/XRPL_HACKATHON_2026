# Architecture decision record 0001: stack, data ownership and demo scope

**Issue:** XRPL-001 · **Status:** Accepted for the hackathon (Wave 0) · **Date:** 2026-11-20
**Owner:** Agent A (Platform, Auth & Data Integrity) · **Network:** XRPL **Testnet only**

This record fixes the stack, trust boundaries, data ownership and demo scope that every
agent builds against. Changing anything here after Wave 0 requires a new ADR in `docs/`.
Detailed agent ownership and the route catalogue live in [CLAUDE_AGENT_HANDOFFS.md](CLAUDE_AGENT_HANDOFFS.md).

## 1. Stack

| Layer | Choice | Version pinned in repo | Notes |
|---|---|---|---|
| Web app + API | Next.js App Router, route handlers under `src/app/api/` | 16.4 | One deployable. `cacheComponents` is off. GET route handlers that read the DB or request data run per request. |
| UI | React 19.1 + Tailwind CSS 4, Testing Library | — | App shell and navigation from XRPL-003 (Agent C). |
| Language | TypeScript, strict | 5.x | Path alias `@/*` → `src/*`. |
| Database | PostgreSQL | 17 (Docker locally) | `docker-compose.yml` for local dev; deployed envs supply `DATABASE_URL`. |
| ORM / migrations | Prisma (`prisma-client` generator, `@prisma/adapter-pg`) | 7.10 | Client generated to `src/generated/prisma` (git-ignored, built on `postinstall`). |
| Validation / contracts | Zod | 4.x | Shared, client-safe schemas in `src/contracts/`. |
| XRPL access | `xrpl` (xrpl.js) behind Agent B's adapter in `src/lib/xrpl/` | — | No other module talks to the ledger directly. |
| Wallet signing | Xaman (Xumm) sign requests + SignIn, server-side SDK | — | Non-custodial. The app never sees a seed or private key. |
| Media / metadata | S3-compatible object storage + public base URL | — | Ticket metadata JSON must be publicly retrievable and stable. |
| Tests | Vitest projects: `unit` (jsdom, Testing Library) and `db` (Node + Postgres); Playwright for e2e (Agent E) | Vitest 3.2 | Server-side unit tests opt into Node with `// @vitest-environment node`. |

## 2. Responsibilities

| Concern | Lives in | Authoritative source | Owner |
|---|---|---|---|
| UI pages, components, client fetching | `src/app/**/page.tsx`, `src/features/*` | — | C (events/profiles/discovery), D (check-in/organiser UI), E (commerce/community UI) |
| HTTP API (route handlers) | `src/app/api/**/route.ts` | — | Per the route table in the handoff doc §5 |
| Users, roles, sessions, wallet links | `src/lib/auth/`, Postgres | **Postgres** (wallet *control* proven only by a signed challenge) | A |
| Events, tiers, prices, supply | Postgres | **Postgres** | A schema, C feature logic |
| NFT identity (`NFTokenID`), current owner, offers | XRPL Testnet | **XRPL** | B |
| Cached owner, sync status, tx history | Postgres (`TicketNFT.cached*`, `LedgerTransaction`) | Cache only; reconciled from validated ledger txs | A (reconciliation), B (ledger reads) |
| Primary sell-out state | Postgres, derived from validated sales | Postgres + ledger reconciliation | A |
| In-app resale eligibility | `src/lib/resale-policy/` | **App policy** (not chain-enforced) | D |
| Check-in uniqueness | Postgres unique index `CheckInRecord(ticketId, eventId)` | **Postgres** | D (A owns the constraint) |
| Ticket metadata JSON, media | Object storage / CDN | Storage (URI recorded on-chain at mint) | B (metadata), E (media) |

## 3. Trust boundaries

1. **Browser → API:** untrusted. Every mutation re-validates input with Zod and enforces role,
   ownership, quantity and policy on the server. UI checks are convenience only.
2. **API → wallet provider (Xaman):** the provider returns *signals* (payload resolved, webhook).
   A webhook or "signed" status is **never** proof of an on-chain outcome.
3. **API → XRPL:** a transaction counts as final only when `tx` returns `validated === true` and
   `meta.TransactionResult === "tesSUCCESS"`. Only then may the app mark a mint, sale, transfer or
   cancellation as done. The submitting wallet provider submits. The API does not re-submit.
4. **Cached ownership is not authorisation.** Before creating/accepting an offer or admitting at the
   gate, read the current owner from XRPL (`account_nfts` / B's `getOwner`).
5. **Client-supplied buyer/owner addresses are never trusted.** Buyer and new owner come from
   validated transaction metadata.
6. **A session identifies an app user, not a wallet.** Session cookies are random tokens stored
   only as hashes (`src/lib/auth/`). Wallet control is established only by a wallet-signed
   challenge (XRPL-012), and roles are enforced server-side (XRPL-013).

## 4. Data model (XRPL-005)

Defined in [`prisma/schema.prisma`](../prisma/schema.prisma). Key invariants, enforced in the DB:

| Invariant | Mechanism |
|---|---|
| An on-chain token maps to one ticket | `TicketNFT.nftokenId` unique (nullable until mint validated) |
| A ticket is admitted once per event | `CheckInRecord @@unique([ticketId, eventId])` |
| A check-in challenge nonce is single-use | `CheckInChallenge.nonce` unique, `consumedAt`, `CheckInRecord.challengeId` unique |
| A tx hash is recorded once; effects applied once | `LedgerTransaction.hash` unique + `appliedAt` |
| An address belongs to one user per network | `WalletLink @@unique([network, address])` |
| No over-minting | CHECK `0 <= mintedQuantity <= totalSupply`, `totalSupply > 0` |
| XRP amounts are integer drops strings | CHECK regex on `priceDrops` / `amountDrops` |
| A tier's numeric price (`priceDropsNumeric`, for price filters and sorting, XRPL-059) equals `priceDrops` | trigger `TicketTier_price_drops_numeric` sets it; CHECK `TicketTier_priceDropsNumeric_matches` |
| A `MINTED` ticket has ledger identity | CHECK `nftokenId`, `mintTxHash`, `mintedAt` present |
| Gifts are zero-price and recipient-bound; private offers name a recipient | CHECK on `NFTOffer` |
| Retried mutations don't double-apply | `IdempotencyRecord @@unique([scope, route, key])` |
| One review per author per event, and per check-in (XRPL-079) | `Review @@unique([eventId, authorId])`, `Review.checkInRecordId` unique |
| A review's check-in is an admission to the same event | trigger `Review_checkin_same_event` |
| Review rating 1–5, body ≤ 2000 characters | CHECK `Review_rating_range`, `Review_body_length` |
| A friend pair is stored once, lower ID first; the requester is one of the pair; `respondedAt` is set exactly when accepted (XRPL-084) | `FriendConnection @@unique([userLowId, userHighId])`, CHECK `FriendConnection_pair_order`, `FriendConnection_requester_in_pair`, `FriendConnection_responded_when_accepted` |
| One block per direction, never of yourself | `UserBlock @@id([blockerId, blockedId])`, CHECK `UserBlock_not_self` |
| "No category" is NULL, never an empty string (XRPL-015/059) | CHECK `Event_category_format` |

Every timestamp is `timestamptz` (UTC). Every app ID is a UUID. Ledger identifiers (`NFTokenID`, offer index,
tx hash) are separate 64-hex strings, canonicalised to upper case by the contracts.

## 5. API conventions

- Success `{ "data": ... }`. Failure `{ "error": { "code", "message", "details"? }, "requestId" }`.
  Use `withApiHandler`, `jsonOk`, `errors.*` and `parseJsonBody` from `src/lib/http/response.ts`.
- Drops are integer strings at every boundary. XRP formatting happens only in the UI.
- Cursors are opaque. `limit` max 100.
- Retriable mint / purchase / check-in mutations take an `Idempotency-Key` header.
- `GET /api/health` reports API + DB readiness with no internals.

## 6. Demo flows (what we will show)

1. **Create and publish:** seller creates an event + tier, publishes it, and it appears in discovery.
2. **Mint:** seller's wallet signs `NFTokenMint` (transferable). The ticket row is marked `MINTED` only from the validated tx.
3. **Primary purchase:** seller signs a primary `NFTokenCreateOffer`. The buyer's wallet signs `NFTokenAcceptOffer`.
   The app reconciles by tx hash. The buyer sees the ticket in *My Tickets* with an explorer link.
4. **Transfer:** owner creates a `Destination`-restricted offer (private sale or zero-price gift) and the recipient accepts.
   Public resale listings appear in-app only after the primary sale is sold out.
5. **Entry:** holder shows a short-lived QR challenge and proves wallet control. The organiser verifies the current on-chain
   owner, event and challenge, and admission is recorded once. A replay or second scan is rejected.

## 7. Live vs simulated vs deferred

| Item | Status | Notes |
|---|---|---|
| NFT mint, offers, accept, cancel on XRPL Testnet | **Live** | Explorer-visible hashes. Never Mainnet. |
| Wallet approval via Xaman | **Live** | Testnet accounts funded from the faucet (developer-only). |
| Ownership verification at the gate | **Live** | Ledger read at scan time. |
| Event/tier data, sessions, check-in records | **Live** (Postgres) | |
| Demo seed users/events | **Simulated** | Clearly labelled seed data (Agent E). |
| Fiat payments for physical merch | **Deferred** (P1, needs explicit approval) | No real-money flows during the hackathon. |
| Resale price caps / royalties as anti-scalping | **Deferred** (P2 spikes 094/095) | Transferable NFTs can move outside the app, so the resale rule is in-app only. |
| Community, friends, Spotify | **Deferred** (P2) | Opt-in visibility by default. |
| Mainnet configuration | **Out of scope** | `XRPL_NETWORK` accepts only `testnet` / `devnet`. |

## 8. Known limitations to state honestly

- The app cannot stop a holder from transferring a transferable NFT outside the app, so the
  sold-out resale rule governs **in-app publication only**.
- App inventory is not globally guaranteed during outside-wallet transfers. Reconciliation corrects the cache after the fact.
- NFT purchase does not transfer copyright in any media.
