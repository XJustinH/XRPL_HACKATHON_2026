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
   `WALLET_NOT_VERIFIED`). That proven wallet is the issuer; the browser never names it. The server
   reserves the next ticket (`PENDING`, metadata URI fixed; 409 when the tier is full) and builds the
   transaction itself: `Account` = the proven wallet, the event's taxon, `tfTransferable`, the ticket's
   URI and a memo (`xrpl-ticketing/ticket`) carrying the ticket ID. It is sent to Xaman as a `MINT_TICKET`
   request, which may only be an `NFTokenMint`. A `PENDING` `LedgerTransaction` links the ticket to the
   request. Response: the ticket, the request (QR code and link) and `metadataPublic`.
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
| Declined, expired, cancelled, or never validated | `FAILED` | `DROPPED` | unchanged |
| Xaman unreachable | unchanged; retried on the next read | unchanged | unchanged |

- **No false mints.** A ticket becomes `MINTED` only from the validated transaction, and only if the
  NFTokenID's issuer and taxon match the ticket's event. While the issuer still holds the NFT, its URI
  must also be the ticket's metadata URI. Anything else is refused and logged, and the ticket is not
  changed.
- **Exactly once.** Effects are applied in one database transaction that first claims the
  `LedgerTransaction` (`appliedAt`). Repeated or concurrent reconciles never count a mint twice, and a
  late answer never moves a ticket back to an earlier status.
- **Failed mints are reusable.** A `FAILED` ticket never got an NFT, so the next mint in that tier reuses
  its serial and URI.
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

- One ticket per approval. Minting a tier's whole quantity is XRPL-025 (needs XRPL-016 from Agent C).
  Retrying failed mints and background reconciliation are XRPL-027 and XRPL-026.
- An unapproved request holds its serial until the Xaman request expires (10 minutes). The next read
  then releases it.
- A demo persona must prove its wallet again in each session (Agent A's rule for shared demo accounts).
- Locally the metadata URI is `localhost`, so Xaman and the explorer cannot show the ticket's details
  (the panel warns when `metadataPublic` is false). The mint itself is valid.

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
- It runs when the seller asks. A scheduled run is a follow-up (XRPL-027).
