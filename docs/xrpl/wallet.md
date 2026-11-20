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

## Next (XRPL-014)

Transaction sign requests (mint, offers, purchases) reuse the same routes with new kinds. Their status
continues past `SIGNED` to ledger validation through `getValidatedTx()` (see
[read-service.md](read-service.md)).
