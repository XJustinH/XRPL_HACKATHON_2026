# Ticket NFTs: metadata, publishing, minting and mapping (Agent B, XRPL-022 to XRPL-026)

Each admission ticket is one XRPL NFT, minted by the seller's own wallet. This page defines what the
NFT carries and how it maps to the app's records. Code: `src/lib/xrpl/tickets/metadata.ts`. Contract:
`TicketNftMetadata` in `src/contracts/xrpl.ts`.

## Identity

| Fact | Where it lives | Rule |
|---|---|---|
| Ticket record | `TicketNFT` row (Agent A's schema) | One row per intended ticket: event, tier and a 1-based `serial` unique within the tier |
| NFT | XRPL `NFTokenID` | Set on the row **only** from a validated `NFTokenMint` (XRPL-024). `TicketNFT.nftokenId` is unique, so one NFT maps to one ticket |
| Link from NFT to ticket | Metadata `ticket.ticketId`, through the NFT's URI | The URI is unique per ticket (XRPL-023), so one ticket maps to one NFT |
| Issuer | Seller wallet that signs the mint | Recorded from the validated transaction's `Account`, never from the browser |
| Current holder | The ledger | Never stored in metadata. Read with `verifyOwner()` / `getOwner()` (XRPL-007) |

## On-ledger settings

| Field | Value | Why |
|---|---|---|
| `Flags` | `tfTransferable` only | Holders can resell or gift (XRPL-036/040/041). Not `tfBurnable`, so the issuer cannot destroy a ticket someone else holds |
| `TransferFee` | none (0) | Royalties are a separate P2 spike (XRPL-094) |
| `NFTokenTaxon` | `ticketTaxon(eventId)`: the first 32 bits of the event UUID | Groups an issuer's tickets per event; stable and needs no storage. Only a grouping hint: identity comes from the URI and the app's mapping, so two events sharing a taxon (the seed data's fixed IDs all start `5eed0000`) is harmless |
| `URI` | Hex of the ticket's metadata URL (≤ 256 bytes) | Points to the JSON below (XRPL-023) |

## Metadata JSON

Served publicly at the ticket's URI. It follows the XLS-24 layout so wallets and explorers can show it:

```json
{
  "schema": "xrpl-ticketing/ticket@1",
  "nftType": "ticket.v1",
  "name": "<event title> — <tier name> #<serial>",
  "description": "Admission ticket NFT for <event> at <venue>, <city>. <event description>",
  "image": "<event artwork URL, or the generated ticket image>",
  "collection": { "name": "<event title>", "family": "XRPL Ticketing" },
  "attributes": [
    { "trait_type": "Event", "value": "..." },
    { "trait_type": "Tier", "value": "..." },
    { "trait_type": "Serial", "value": 1 },
    { "trait_type": "Venue", "value": "..." },
    { "trait_type": "City", "value": "..." },
    { "trait_type": "Starts", "value": "2027-03-12T20:00:00.000Z" }
  ],
  "ticket": {
    "ticketId": "<TicketNFT.id>", "eventId": "...", "tierId": "...",
    "serial": 1, "issuer": "r...", "network": "TESTNET"
  },
  "event": { "title": "...", "startsAt": "...", "endsAt": "...", "venue": "...", "city": "..." },
  "tier": { "name": "...", "priceDrops": "2500000" }
}
```

- **No attendee information.** Buyers and holders are never named, and there are no emails, display
  names or user IDs. Who holds a ticket is a ledger fact, read live.
- `priceDrops` is the tier's face value at mint, in drops, as an integer string.
- `schema` is versioned. A future change bumps it, so readers can tell the shapes apart.

## Publishing the metadata (XRPL-023)

| Route | Returns |
|---|---|
| `GET /api/tickets/:id/metadata` | The ticket's `TicketNftMetadata` as **raw JSON**, not the `{ data }` envelope, because wallets and explorers read metadata at the top level. Public, `Access-Control-Allow-Origin: *`, 404 for unknown tickets |
| `GET /api/tickets/:id/image` | Generated SVG ticket artwork. Used as `image` when the event has no https artwork. All text is XML-escaped, nothing external is loaded, and it is served with `Content-Security-Policy: default-src 'none'` |

- **One URI per ticket:** `<base>/api/tickets/<ticketId>/metadata`. It is stored in `TicketNFT.metadataUri`
  when the ticket is reserved (`createPendingTicket`, `src/lib/xrpl/tickets/store.ts`) and written into
  the NFT at mint (XRPL-024).
- **Base URL:** `TICKET_METADATA_BASE_URL`, falling back to `APP_BASE_URL`. **It must be the app's public
  https address in any shared environment**; once a URI is on the ledger it cannot change. Locally it is
  `http://localhost:3000`, which wallets and explorers cannot reach, and `isPubliclyReachable()` reports
  that. Test mints made locally will not show an image in Xaman or on the explorer.
- Reserving a ticket allocates the next serial in the tier. It reuses a ticket whose mint failed (it
  never produced an NFT), and counts PENDING, SUBMITTED and MINTED tickets against the tier's supply
  (409 when the tier is full).
- **Limitation:** the JSON is rendered from the current event and tier records. If a seller edits an
  event after minting, the served metadata follows the edit. Freezing it would need either a stored
  snapshot (a schema request to Agent A) or content-addressed storage (IPFS/S3), as a follow-up.

## Minting a ticket (XRPL-024)

The seller mints one ticket at a time from the event's own page (`/seller/events/:id`, below Agent C's
tier setup), signing each `NFTokenMint` in their own Xaman wallet. The app never holds a seller key. Code:
`src/lib/xrpl/tickets/minting.ts`, `src/app/api/events/[id]/mints/route.ts`, UI in `src/features/minting/`.

1. **Request.** `POST /api/events/:id/mints` with `{ tierId }` and an `Idempotency-Key` header. Only the
   event's owner may mint (Agent A's `requireEventOwner`: 401 / 404 / 403 `NOT_EVENT_OWNER`), and only
   with the wallet this session has proven through Xaman sign-in (XRPL-012, `requireProvenWallet`: 403
   `WALLET_NOT_VERIFIED`). That proven wallet is the issuer; the browser never names it. The server first
   settles the tier's mints in flight and checks the wallet can pay for the mint (XRPL-027, below). It
   then reserves the next ticket (`PENDING`, metadata URI fixed; 409 when the tier is full) and records
   the attempt in the same database transaction: a `PENDING` `LedgerTransaction`, later linked to the
   request. It builds the transaction itself: `Account` = the proven wallet, the event's taxon,
   `tfTransferable`, the ticket's URI, a memo (`xrpl-ticketing/ticket`) carrying the ticket ID, and a
   `LastLedgerSequence` 300 ledgers past the validated ledger. It is sent to Xaman as a `MINT_TICKET`
   request, which may only be an `NFTokenMint`. Response: the ticket, the request (QR code and link) and
   `metadataPublic`.
2. **Approve.** The seller checks and approves in Xaman. `TransactionApproval` follows the request:
   submitted, then confirmed with an explorer link.
3. **Reconcile.** `GET /api/events/:id/mints` brings every mint in flight up to date (up to 20 per call)
   and returns the event's tiers and tickets. The panel reloads it when the approval finishes, so a page
   refresh shows the same result.

How a mint is recorded (`reconcileTicketMint`):

| Request outcome | Ticket | `LedgerTransaction` | Tier `mintedQuantity` |
|---|---|---|---|
| Validated `tesSUCCESS` `NFTokenMint` (re-checked with `getValidatedTx`) | `MINTED` with `nftokenId`, `mintTxHash`, `mintedAt` (ledger close time), issuer = the transaction's `Account` | `VALIDATED_SUCCESS`, `appliedAt` set | +1, once |
| Signed and submitted, not yet validated | `SUBMITTED` | hash recorded | unchanged |
| Rejected by the ledger (`tec…`, fee charged) | `FAILED` | `VALIDATED_FAILURE` | unchanged |
| Declined (before or after Xaman's expiry), cancelled, expired unopened, or never validated | `FAILED` | `DROPPED` | unchanged |
| Opened in Xaman before it expired, not answered yet | unchanged until its `LastLedgerSequence` passes, then as expired | unchanged | unchanged |
| Xaman couldn't create the request | `FAILED` at once | `DROPPED` | unchanged |
| Never recorded: the server stopped before recording the request, or couldn't free the ticket after a failed create | `FAILED` once its `LastLedgerSequence` passes | `DROPPED` | unchanged |
| Xaman no longer has the request, past its `LastLedgerSequence`, and it was signed (hash recorded) | from its transaction: as the rows above. If the node doesn't know the transaction, as the next row | as above | as above |
| The same, unsigned as far as the app knows | the issuer's history is searched for the ticket's mint: recorded as `MINTED` if found, `FAILED` if the search rules one out, otherwise unchanged | as above | +1 if found |
| Xaman unreachable | unchanged; retried on the next read | unchanged | unchanged |

- **No false mints.** A ticket becomes `MINTED` only from the validated transaction, and only if the
  NFTokenID's issuer and taxon match the ticket's event. While the issuer still holds the NFT, its URI
  must also be the ticket's metadata URI. Anything else is refused and logged, and the ticket is not
  changed.
- **Exactly once.** Effects are applied in one database transaction that first claims the
  `LedgerTransaction` (`appliedAt`). Repeated or concurrent reconciles never count a mint twice, and a
  late answer never moves a ticket back to an earlier status.
- **Failed mints are reusable.** A `FAILED` ticket never got an NFT, and nothing signed for its last
  attempt can validate any more, so the next mint in that tier reuses its serial and URI (XRPL-027).
- **Idempotency.** A repeated `Idempotency-Key` replays the first response (`Idempotent-Replayed: true`)
  instead of reserving another ticket. The same key with a different body gets 422
  `IDEMPOTENCY_KEY_REUSED`, and 409 while the first request is still running. Keys last 24 hours and
  are scoped per user (`src/lib/xrpl/idempotency.ts`, on Agent A's `IdempotencyRecord`). The panel
  reuses the key only when a request got no response.

Verified on XRPL Testnet (20 Nov 2026), with the server-built transaction signed by a dev seller wallet and
recorded by the reconciler from the validated ledger:
[`FDA1B6E6…68847014`](https://testnet.xrpl.org/transactions/FDA1B6E60466B33558E246E9C4EB697B39D62FB39C908E8CD2B0A13168847014)
(`tesSUCCESS`, ledger 22480936) minted NFT
[`000800007AEF…0156FB28`](https://testnet.xrpl.org/nft/000800007AEF3497563B53E5B5C1C3BF3278E4831BD6183441C7ACC30156FB28)
(transferable, the event's taxon, the ticket's metadata URI).

Limitations:

- One ticket per approval: the seller signs each NFTokenMint. A tier's whole quantity is minted as a run
  of approvals (XRPL-025, below). Failures and retries: XRPL-027, below.
- An unapproved request holds its serial until Xaman reports it expired (10 minutes unopened). One opened
  in Xaman holds it until its `LastLedgerSequence` passes, since it can still be signed until then. The
  next read, or the next mint in the tier, then releases it.
- A demo persona must prove its wallet again in each session (Agent A's rule for shared demo accounts).
- Locally the metadata URI is `localhost`, so Xaman and the explorer cannot show the ticket's details
  (the panel warns when `metadataPublic` is false). The mint itself is valid.

## Minting a tier's quantity (XRPL-025)

Each ticket is still its own seller-approved `NFTokenMint`: the app holds no key, so it cannot mint on
the seller's behalf. **Mint all N remaining** on a tier runs those approvals one after another:

- **Progress.** The panel shows "k of N minted", the approval for the current ticket, and moves to the
  next ticket as soon as the ledger validates the current one. Each tier lists its minted, pending
  (awaiting approval or validation) and failed tickets separately, with counts.
- **Bounded.** A run never asks for more than the tier's remaining quantity (configured supply minus
  minted and pending tickets), and the server refuses any reservation beyond supply. Reservations for a
  tier are serialised (the tier row is locked while a ticket is reserved), so concurrent requests, two
  tabs or a double click cannot reserve past the supply or take the same failed ticket twice.
- **Retry-safe.** Step `n` of a run sends `Idempotency-Key: <run key>-<n>`. If a step's answer is lost,
  **Try again** resends the same key and gets the same ticket and request back instead of a second one.
- **Stops on trouble.** The run stops at the first ticket that is declined, expires, is cancelled or
  fails on the ledger, and says why. **Stop after this ticket** ends it after the current approval.
  Starting again later continues towards the configured quantity; failed tickets are reused.

Verified on XRPL Testnet (20 Nov 2026): two tickets of one tier minted in sequence through the same server
path, each signed by a dev seller wallet and recorded from the validated ledger
([`49A9C88E…76DC2A96`](https://testnet.xrpl.org/transactions/49A9C88EB25AE8FE4D4A59850CEC5AD8EA4837D148C0C6DF437F699576DC2A96),
[`BB164BAB…0FEC871C`](https://testnet.xrpl.org/transactions/BB164BAB9033F692D722C4AB779FDE62B4E8D7017CF90EBBE66A47CC0FEC871C));
the tier went from 1 to 3 of 10 minted and the ledger check verified all three.

Limitations:

- One approval per ticket. On a phone, each step's **Open in Xaman** opens the next request; on a
  computer, each step shows a new QR code. Pushing follow-up requests straight to the seller's Xaman app
  (Xaman user tokens) is a possible follow-up.
- A run lives in the open page. Leaving the page stops it after the current request; the tickets and
  their statuses are kept, and **Mint all N remaining** picks up where it left off.

## Failures and retries (XRPL-027)

A mint can fail before, during or after its approval. Each failure says what happened, a retry never
gives a ticket a second NFT, and the tier's counts stay right. Code: `src/lib/xrpl/tickets/minting.ts`,
`store.ts`, and `findTicketMint` / `recordTicketMint` in `mapping.ts`.

**Distinguishable errors.** Where the seller sees each one:

| When | Cause | What the seller sees |
|---|---|---|
| Before anything is reserved (`POST /api/events/:id/mints`) | The wallet isn't activated on the ledger | 409 (`details.reason: "ACCOUNT_NOT_FOUND"`): fund it with at least the base reserve |
| | The wallet can't keep one owner-reserve increment (0.2 XRP on Testnet) plus the fee spare | 409 (`details.reason: "INSUFFICIENT_RESERVE"`, `requiredDrops`, `spendableDrops`): how much is spare |
| | The ledger node has no validated ledger | 503 |
| When the approval ends (the run's stop message) | Declined, cancelled or expired in Xaman | Which of the three |
| | Rejected by the ledger with `tecINSUFFICIENT_RESERVE` | That the wallet doesn't hold enough XRP for the reserve, and to add XRP first |
| | Rejected by the ledger with another `tec…` result | The result code, and that the fee was charged |
| | Refused by the network (`tem…`/`tef…`), not validated in time, or signed on another network | Which one, in words, and that nothing was charged |
| Right after, on each failed ticket's row (the panel reloads `GET /api/events/:id/mints` as the run stops) | Its latest attempt (`mintFailure`) | `NOT_APPROVED`, `REQUEST_FAILED`, `INSUFFICIENT_RESERVE` or `LEDGER_REJECTED` (with the failed transaction's link and that the fee was charged), or `NOT_VALIDATED` |

The reserve check assumes the mint needs a new NFT page. Each page holds one increment of the issuer's
XRP, and which page a new NFT lands on depends on its position among the wallet's NFTs. Without the
check, the ledger would reject the mint with `tecINSUFFICIENT_RESERVE` and still charge the fee.

**A retry never mints a ticket twice.**

- **Retry reuses the failed ticket.** The panel's single-mint button reads **Retry #n** while a tier has
  failed tickets. The server reuses the lowest-numbered one, with its serial and metadata URI. A `MINTED`
  ticket is never reserved again, and a ticket's NFT mapping is never overwritten.
- **Only once nothing can validate.** A ticket becomes `FAILED`, and so reusable, only when nothing signed
  for its last attempt can validate any more:
  - Every mint carries a `LastLedgerSequence` 300 ledgers past the validated ledger (`MINT_LEDGER_WINDOW`,
    about 15 to 20 minutes). Xaman's documentation says a ledger index in that field "will be passed on
    unchanged" ([payload lifecycle](https://docs.xaman.dev/concepts/payloads-sign-requests/lifecycle)), so
    the ledger refuses anything signed later.
  - Xaman's 10-minute expiry only limits opening a request, and a request opened in time can still be
    answered. So one opened in time and not answered stays `OPENED`, holding its ticket, until that
    ledger passes. The approval card shows no expiry time for it then. Declining it frees the ticket at
    once.
  - A network refusal (`tem…`/`tef…`) only counts while the node has never seen the transaction.
- **Settled first.** Before reserving, the tier's mints in flight are brought up to date. A mint
  confirmed meanwhile is recorded instead of its ticket being reserved again. A declined or expired one
  frees its ticket for this very request.
- **Lost requests.** A request Xaman no longer has is settled from the ledger once its
  `LastLedgerSequence` has passed:
  - If it was signed and the node knows its transaction, from that transaction.
  - Otherwise the issuer's history is searched, newest first, for a mint carrying the ticket's memo: up
    to its 1,200 most recent transactions, stopping at the first one from before the request. A mint
    found there is recorded once, with the ledger check's checks. A mint that doesn't match the ticket
    leaves it as it is, for the ledger check to report.
  - The ticket is freed only when the search rules a mint out: it read back past the request, or the
    account has nothing older and the node's history starts at least 1,000 ledgers before the request's
    `LastLedgerSequence`. A node that keeps less history can't show an older mint, so its empty answer
    proves nothing and the ticket stays as it is.
- **Idempotency.** A repeated `Idempotency-Key` still replays the first response.

**Inventory stays consistent after a partial failure.**

- Every attempt is recorded in the same database transaction that reserves its ticket. So no reservation
  is left without a record that a reconcile can settle, even if the server stops before the request
  exists or is recorded.
- A tier's `mintedQuantity` goes up once per validated mint, from the request or from the ledger.
- `FAILED` tickets count as left to mint. `PENDING` and `SUBMITTED` ones count against the supply only
  until they are settled, so a tier is never left full of requests nobody can sign.
- A run that stops at a failure keeps its minted tickets. Starting it again retries the failed ticket
  first, then continues towards the configured quantity.

Verified on XRPL Testnet (21 Nov 2026). A script standing in for Xaman signed the server-built mints
with a fresh wallet, funded with the base reserve plus 0.1 XRP, and submitted them with xrpl.js:

1. The reserve check refused the mint with 409 ("this wallet has 0.1 XRP spare"), and nothing was reserved.
2. The check was then bypassed for one request, as if the wallet's XRP had moved between the check and
   the signature. The ledger rejected that mint:
   [`5222366A…0A5117DB`](https://testnet.xrpl.org/transactions/5222366AACDE8A61F38B1DD894EC154ADB93A57FF53F0B3B324B20550A5117DB)
   (`tecINSUFFICIENT_RESERVE`, ledger 22488158). It was recorded `FAILED`, reason `INSUFFICIENT_RESERVE`.
3. After a 0.5 XRP top-up, the retry reused the same ticket (ID, serial and URI) and minted it:
   [`A4293205…15BA0F0D`](https://testnet.xrpl.org/transactions/A4293205335EF398A91EA36A1507ED467A49519E969BEF63195ABA2015BA0F0D)
   (`tesSUCCESS`, ledger 22488162).
   - The tier went to 1 of 1, and the wallet held one NFT.
   - Another mint got 409.
   - The ledger check verified the mint.
4. The server-built `LastLedgerSequence` (300 past the validated ledger at the time) reached the ledger
   unchanged in both validated mints. That Xaman itself leaves it unchanged rests on its documentation,
   and is worth confirming once with a real Xaman approval during the demo rehearsal.

Limitations:

- A wallet with less than 0.2 XRP spare is refused even when the NFT would fit on an existing page. It
  couldn't list the ticket for sale either: each sell offer holds 0.2 XRP.
- After a reload, a request declined, cancelled or expired in Xaman shows as "Not approved in Xaman". The
  app keeps the ledger's outcome, not Xaman's answer. The run's stop message says which at the time.
- A request opened in Xaman and left unanswered holds its ticket until its `LastLedgerSequence` passes.
  The seller can end the wait by declining it in Xaman.
- Attempts recorded before XRPL-027 have no `LastLedgerSequence`, so the app's 15-minute rule applies to
  them instead. One that Xaman lost is freed only when the history search reads back past it.
- A lost request's ticket stays pending, and this is logged, when the search can't rule a mint out:
  more than 1,200 of the issuer's transactions are newer than the request, or the node keeps too little
  history (the public Testnet fallback node keeps about two hours). Nothing in the app frees it then.
  The seller's **Check against the ledger** still records a mint that did happen.
- Offer and purchase requests don't carry a `LastLedgerSequence` yet. An offer request opened before it
  expired can still be signed after the app has recorded it as failed. That is a follow-up for the offer
  code.

## Mapping NFTs to tickets (XRPL-026)

Each minted ticket's `TicketNFT` row holds the full mapping: event, tier, issuer, metadata URI, NFTokenID
and mint transaction. The ledger stays the source of truth, and the seller can check the two agree with
**Check against the ledger** on the event's page (`/seller/events/:id`). It calls
`POST /api/events/:id/mints/reconcile` (event owner only). Code: `src/lib/xrpl/tickets/mapping.ts`.

- **Rebuild.** Every ticket mint carries the `xrpl-ticketing/ticket` memo with its ticket ID. The check
  reads each issuer's validated mint history (`getAccountMints`, rippled `account_tx`) and records any
  successful ticket mint the app missed, for example when the wallet service lost a request's outcome.
  It is recorded exactly once: it claims the request's `LedgerTransaction` (or creates one keyed by the
  unique transaction hash), and the tier's `mintedQuantity` goes up once.
- **Verify.** Every `MINTED` ticket is compared with its mint transaction: from that history, or else
  re-read with `getValidatedTx`. The NFTokenID and issuer must match.
- **Never overwrite.** Disagreements are listed in the report and nothing is changed for them:

| Problem | Meaning |
|---|---|
| `TICKET_NOT_FOUND` | A validated mint with this event's taxon names a ticket the app has no record of |
| `URI_MISMATCH` / `TAXON_MISMATCH` | A ticket's mint does not carry its metadata URI or the event's taxon |
| `TICKET_HAS_OTHER_NFT` | The ledger shows a mint for a ticket that already maps to a different NFT |
| `NFT_MAPPED_TO_OTHER_TICKET` | The NFT already maps to another ticket. The database refuses it: `TicketNFT.nftokenId` is unique |
| `MINT_TX_MISMATCH` | A minted ticket's recorded mint transaction shows a different NFT or issuer |
| `MINT_TX_NOT_VALIDATED` | The ledger node could not confirm a minted ticket's mint transaction |

- The request reconciler (XRPL-024) follows the same rule: it only fills in a ticket that has no NFT yet.
- A ledger outage is an error (503), never a list of false problems.
- Verified on Testnet (20 Nov 2026): with the mapping of the ticket minted above erased from the
  database, one check found its mint in the issuer's history and restored the same NFTokenID, mint
  transaction, close time and tier count. A second check recorded nothing and verified it.

Limitations:

- Each check reads an issuer's most recent 4,000 transactions; the report says when history went further
  (`complete: false`). Older mints are still verified one by one through `getValidatedTx`.
- History is limited to what the node keeps (the public Testnet node answered with about a year of
  ledgers). A Clio node keeps everything.
- It runs when the seller asks. A request Xaman lost has its ticket's mint looked for in the issuer's
  recent history automatically (XRPL-027). A scheduled full check is a follow-up.
