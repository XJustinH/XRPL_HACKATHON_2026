# XRPL read/query service (Agent B, XRPL-007)

One place for every XRPL read, so pages and routes never call the ledger directly.
Code: `src/lib/xrpl/query.ts`. Types: `src/contracts/xrpl.ts`. Setup: [testnet.md](testnet.md).

```ts
import { getXrplQueryService } from "@/lib/xrpl";

const xrpl = getXrplQueryService(); // shared instance: one connection per server process

const check = await xrpl.verifyOwner(nftokenId, walletAddress);
if (!check.owns) {
  /* reject */
}
```

## Methods

| Method | Returns | Use it for |
|---|---|---|
| `getNetworkStatus()` | `XrplNetworkStatus` | `GET /api/xrpl/status`, health checks |
| `getAccountInfo(address)` | `AccountSummary` (`exists: false` if never funded) | Wallet readiness before asking for a signature (011, 014, 030) |
| `getAccountNfts(address, { cursor?, limit? })` | `AccountNftsPage` (`items`, `nextCursor`) | Wallet NFT lists (028, 033). rippled returns at least 20 per page |
| `verifyOwner(nftokenId, address)` | `NftOwnershipCheck` | **"Does this wallet hold this ticket right now?"** Gate checks, pre-transfer checks (028, 036, 046) |
| `getOwner(nftokenId)` | `NftOwnership` | Find the current owner when you do not know it, e.g. after an external transfer (028, 043). Needs Clio |
| `getOffers(nftokenId)` | `LedgerNftOffers` (sell + buy) | Listings, stale-offer checks (029, 035, 038, 042) |
| `getTransaction(hash)` | `LedgerTxLookup` (`VALIDATED` / `PENDING` / `NOT_FOUND`) | Showing progress after a wallet signs (014) |
| `getValidatedTx(hash)` | `ConfirmedLedgerTx`, or throws | **The only gate for marking anything confirmed** (024, 031, 032, 039, 043) |
| `getFeeEstimateDrops()` | Drops string | Fee shown in purchase quotes (030). The signing wallet sets the real fee |

All inputs are validated before any network call, including the address checksum and 64-hex IDs.
Hex IDs come back upper-case. Amounts are drops as integer strings.

### Backing Agent C's `LedgerReadPort` (`src/features/integration/ports.ts`)

| Port method | Source |
|---|---|
| `getOwner(nftokenId)` | `(await getOwner(id)).ownerAddress`; map `NOT_FOUND` to `null` |
| `getFeeEstimateDrops()` | `getFeeEstimateDrops()`; map errors to `null` |
| `getLedgerProof(nftokenId)` | Owner, `ledgerIndex`, `verifiedAt` (`provenance.fetchedAt`) and explorer links from this service. Mint/transfer hashes and metadata URI come from the ticket record (XRPL-026/028) |
| `listTicketsForOwner`, `getTicket` | Ticket records joined with these reads (XRPL-026/028) |

The adapter that implements the port is part of XRPL-028, once ticket records exist.

## Rules that matter

- **Never show or store a transaction as confirmed unless `getValidatedTx()` returned it.** It throws
  `NOT_VALIDATED` (retryable) while the transaction is pending or unknown, and `TX_FAILED` if the ledger
  validated it with any result other than `tesSUCCESS`.
- `getTransaction()` reports `NOT_FOUND` when no node knows the hash yet. That is not a failure by itself:
  a just-signed transaction may not have reached a validated ledger. Expiry (LastLedgerSequence) is
  handled by the signing flow (XRPL-014/027).
- Prefer `verifyOwner()` when you know which wallet should hold the NFT. It works on any rippled node.
  `getOwner()` uses Clio's `nft_info` and throws `CONFIG_ERROR` if Clio is disabled.
- `getOffers()` returns empty lists for an NFT with no offers (rippled reports that as `objectNotFound`,
  which the service absorbs). It cannot tell "no offers" from "no such NFT".
- Expired offers stay on the ledger until cancelled. Compare `expiresAt` with the current time before
  presenting an offer as buyable.
- If a rippled node does not know a transaction (fallback nodes keep only a few hours of history),
  `getTransaction()` asks the full-history Clio node before answering `NOT_FOUND`.
- `LedgerNftOffer` is the live on-ledger offer. It is not the app's `NFTOfferDto` record.

## Provenance

Every result has `provenance: { endpoint, ledgerIndex, ledgerHash, validated, fetchedAt }`. Account, NFT
and offer reads always query the latest validated ledger, and multi-page reads stay pinned to the first
page's ledger. `ledgerIndex` is `null` when the node does not report it (rippled never does for offer
lists). For a transaction, `validated` is the transaction's own state.

## HTTP routes

Route handlers stay thin and use Agent A's envelope (`withApiHandler`, `jsonOk`). Responses are
`Cache-Control: no-store` and never prerendered (`connection()`).

| Route | Returns |
|---|---|
| `GET /api/xrpl/status` | `{ data: XrplNetworkStatus }` |
| `GET /api/xrpl/wallets/:address/nfts?cursor&limit` | `{ data: AccountNftsPage }` (`limit` 1-100, shared `PageQuery`) |
| `GET /api/xrpl/transactions/:hash` | `{ data: LedgerTxLookup }`. An unknown hash is a 200 with status `NOT_FOUND` |

`toLedgerAppError()` (`src/lib/xrpl/http.ts`) maps service errors onto the shared codes:

| Service code | HTTP | API code |
|---|---|---|
| `INVALID_INPUT` | 400 | `VALIDATION_FAILED` |
| `NOT_FOUND` | 404 | `NOT_FOUND` |
| `TIMEOUT`, `NODE_UNAVAILABLE`, `RPC_ERROR` | 503 | `LEDGER_UNAVAILABLE` (`details.retryable`) |
| `NOT_VALIDATED` | 409 | `LEDGER_TX_NOT_VALIDATED` |
| `TX_FAILED` | 409 | `LEDGER_TX_FAILED` |
| `CONFIG_ERROR`, `WRONG_NETWORK` | 503 | `SERVICE_UNAVAILABLE` (details logged server-side only) |

Node URLs and internal messages are never returned to clients for 404/503 responses.

## Live check

```bash
npm run xrpl:dev-wallet -- seller   # once
npm run xrpl:dev-wallet -- buyer    # once
npm run xrpl:smoke-read
```

Developer-only. It signs with the throwaway dev wallets to mint a test NFT, list it for 1 XRP and transfer
it, then checks every read against what happened (17 checks) and prints explorer links.
