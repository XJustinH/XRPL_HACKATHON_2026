# Wallet connection with Xaman (Agent B, XRPL-011)

Users connect their own XRPL wallet through [Xaman](https://xaman.app). The app never asks for, sees
or stores a seed phrase or private key. Users approve every request inside the Xaman app.

## Setup

1. Create an app in the Xaman Developer Console and copy its API key and secret.
2. Put them in your local `.env` (git-ignored):

   ```dotenv
   XAMAN_API_KEY=...
   XAMAN_API_SECRET=...
   ```

   Both are server-only. Never prefix them with `NEXT_PUBLIC_`, and never commit them. If a secret
   leaks, regenerate it in the console and update `.env`.
3. In the Xaman app, use an account on XRPL Testnet. Fund a throwaway Testnet account from the faucet
   if needed: `npm run xrpl:dev-wallet -- <label>` prints a funded address, and its seed can be
   imported into Xaman for testing.

Without credentials the wallet routes answer `503 SERVICE_UNAVAILABLE` and the server logs why.

## How connecting works

```text
Browser (/connect)          App API                          Xaman
  Connect ------------->  POST /api/wallet/sign-requests --> create SignIn payload
                          (force_network = TESTNET, 5 min)
  shows QR / "Open in Xaman"            user scans and approves in the Xaman app
  polls --------------->  GET /api/wallet/sign-requests/:id -> payload status
  SIGNED + networkMatches -> stores the public address in this browser
```

- A **sign-in** (Xaman's `SignIn` pseudo-transaction) proves which account the user controls. It moves
  no funds and is never submitted to the ledger.
- Requests are pinned to the app's network with Xaman's `force_network`. If a wallet still signs on
  another network, the request is reported with `networkMatches: false`. The UI then refuses to
  connect and tells the user to switch networks in Xaman.
- **Disconnect** forgets the address in this browser. Nothing is stored server-side.
- Linking the wallet to a user account (sessions, verified signature) is **XRPL-012 (Agent A)**. The
  signed blob carries Xaman's sign-in memo with the request ID; `getSignedSignIn(id)` in
  `src/lib/xrpl/wallet/sign-requests.ts` returns it for a signed request on the right network.

## API

| Route | Returns |
|---|---|
| `POST /api/wallet/sign-requests` `{ "kind": "SIGN_IN" }` | `201 { data: SignRequest }` with `signUrl` and `qrPngUrl` |
| `GET /api/wallet/sign-requests/:id` | `{ data: SignRequest }`. Poll until the status is final |
| `DELETE /api/wallet/sign-requests/:id` | `{ data: SignRequest }`, normally `CANCELLED` |
| `GET /api/wallet/readiness?address&requiredDrops` | `{ data: WalletReadiness }` (Agent C's contract) |

`SignRequest.status` is `PENDING`, `OPENED`, `SIGNED`, `REJECTED`, `EXPIRED` or `CANCELLED`
(`src/contracts/xrpl.ts`). Only `SIGNED` with `networkMatches: true` counts as connected.

Readiness reports the **spendable** balance: balance minus the account reserve (base reserve plus the
per-object increment times owned objects). `canPurchase` also keeps one increment spare, because
receiving an NFT can create a new NFT page the buyer must reserve for. A ledger outage becomes a blocker
message rather than an error.

Errors use the shared envelope: `400 VALIDATION_FAILED`, `404 NOT_FOUND` (unknown request),
`503 SERVICE_UNAVAILABLE` (Xaman unreachable, `details.retryable: true`, or not configured).

## UI

`src/features/wallet/wallet-connect-panel.tsx` renders on `/connect`. It covers:

- Connect, then a QR code with "Open in Xaman" (mobile), the request status and expiry, and Cancel.
- Once connected: the address, network badge, spendable balance or blockers, and Disconnect.
- Recovery messages for wrong network, declined, expired, cancelled and service unavailable.

Other client code can read the connected wallet with `useConnectedWallet()` from
`src/features/wallet/wallet-store.ts`.

## Transaction approvals (XRPL-014)

Mint, offer and purchase actions ask the user's wallet to sign a real XRPL transaction. Xaman submits
it, and the app follows it to a validated ledger.

```text
Feature route (e.g. mint, XRPL-024)
  builds + validates the transaction on the server
  -> WalletTransactionRequests.create({ purpose, txjson, instruction, reference })
     Xaman payload: submit = true, force_network, 10 min expiry, purpose/reference in custom_meta
  <- TransactionRequest (PENDING) with signUrl + qrPngUrl
Browser renders <TransactionApproval request={...} />, which polls
  GET /api/wallet/transaction-requests/:id
     Xaman status -> once signed, look the tx up on the ledger (getTransaction)
```

| Status | Meaning |
|---|---|
| `PENDING` / `OPENED` | Waiting for the user in Xaman |
| `REJECTED` / `EXPIRED` / `CANCELLED` | Never signed, so nothing was sent. The UI offers "Try again" |
| `SUBMITTED` | Signed and submitted, waiting for a validated ledger |
| `CONFIRMED` | Validated with `tesSUCCESS`. **The only success state.** Carries `explorerUrl` |
| `FAILED` | See `failureReason` below |

| `failureReason` | Meaning |
|---|---|
| `LEDGER_REJECTED` | Validated with a `tec` result. The fee was charged; nothing else changed. Has an explorer link |
| `NETWORK_REJECTED` | Refused before any ledger (`tem`/`tef`). Nothing was charged |
| `NOT_VALIDATED_IN_TIME` | The signed blob's `LastLedgerSequence` passed without validation. Nothing was charged |
| `WRONG_NETWORK` | The wallet signed on another network |

- The server never accepts a raw transaction from the browser. Each `TransactionPurpose` maps to exactly
  one transaction type (`PURPOSE_TRANSACTION_TYPES` in `transaction-requests.ts`), and the route that
  owns the purpose builds the transaction from its own records.
- To add a purpose (XRPL-024/029/031/036/040-042): add it to `TransactionPurpose` in
  `src/contracts/xrpl.ts`, map it in `PURPOSE_TRANSACTION_TYPES`, and create requests from the
  feature's route. The UI needs no change: render `<TransactionApproval request={request} onRetry={...} />`.
- The service keeps no state of its own. The purpose and reference ride in Xaman's `custom_meta`, and
  the ledger is the source of truth. Reconciliation into app records stays with XRPL-026/032/043.
- Xaman webhooks are not used yet: they need a public URL and are only a hint per ADR 0001. The status
  route polls instead.

### Developer check

`POST /api/wallet/transaction-requests` with `{ "purpose": "TEST", "account": "r..." }` creates a no-op
`AccountSet` for that account. Once a wallet is connected, `/connect` shows a **Send a test
transaction** button, so the full flow can be checked: sign, submit, validate, explorer link. The
account must be active on the network, because the fee comes from it.

`XRPL_TEST_TRANSACTIONS_ENABLED=true|false` controls it. It defaults to on outside production and off in
production, the same rule as `DEMO_LOGIN_ENABLED`. When it is off, the route answers 404.
