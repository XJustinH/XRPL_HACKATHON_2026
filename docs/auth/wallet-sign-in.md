# Wallet sign-in and wallet-control proof (XRPL-012)

**Owner:** Agent A. **Provider:** Xaman (formerly XUMM), through Agent B's adapter in
`src/lib/xrpl/wallet/`. **Code:** `src/lib/auth/wallet-proof.ts`, `src/lib/auth/wallet-sign-in.ts`.

A visitor proves they control an XRPL account by approving a Xaman **SignIn** request in their own
wallet. The app never sees a seed or private key. A proof is accepted only once, only in the browser
that started it, only before it expires, and only after the server has verified the signature itself.

## What Xaman provides

| Capability | Used for | Notes |
|---|---|---|
| `SignIn` pseudo-transaction (sign request / "payload") | Proving wallet control | Xaman docs: *"signature only, can never be submitted."* No funds move. |
| Server-side payload API (`X-API-Key` / `X-API-Secret`) | Creating requests, reading the result | Fetched server-to-server; the browser never sees the API secret. |
| `options.force_network` | Pinning requests to Testnet | Xaman refuses to sign on another network (observed: it asks the user to switch). |
| Payload expiry (`options.expire`) | Bounding open requests | Xaman's expiry is *"open/scan before"*, not *"resolve before"*. Our proof has its own 10-minute window. |
| Signed blob in the result (`response.hex`) | Independent verification | Format below. Xaman recommends checking it (they point to `verify-xrpl-signature`). We use the equivalent pure helpers from `xrpl`. |
| Webhooks | Not used | Webhooks can't reach `localhost`. The UI polls `GET /api/wallet/sign-requests/:id` instead. |

### Signed SignIn blob (verified against a real Testnet signature, 2026-11-20)

The blob decodes with the standard XRPL binary codec and contains exactly:

| Field | Value |
|---|---|
| `Account` | the signer's classic address (equals Xaman's `response.account`) |
| `SigningPubKey` | the key that signed (Ed25519 `ED…` or secp256k1) |
| `TxnSignature` | the signature over the blob's signing data |
| `Memos` | one memo: `MemoType = "xaman-signin"`, `MemoData = <payload UUID>` |

There is **no `TransactionType`, `Fee` or `Sequence`**, which is why it can never be submitted.
`hashSignedTx(hex)` equals Xaman's `response.txid`. The memo ties the signature to one specific
request, so a signature for one request can't be replayed against another.

## How the server verifies a proof

`WalletProofService.verify()` requires every one of these:

1. **Created by us:** a `WalletProof` row exists for the payload UUID (made by `/api/auth/challenge`)
   on the app's network.
2. **Bound:** it must come from the browser holding the httpOnly binding cookie set by
   `/api/auth/challenge`. The database stores only the token's SHA-256.
3. **Fresh and unused:** not expired and not consumed.
4. **Signed on our network:** Xaman reports it `SIGNED` with `networkMatches` (B's `getSignedSignIn`).
5. **Signature verified locally:** the blob is the non-submittable SignIn shape, its `xaman-signin`
   memo names this payload, `verifySignature(blob)` passes, `Account` equals Xaman's reported account,
   and `deriveAddress(SigningPubKey)` equals that account (the master key).
6. **Right wallet:** if the challenge named an address, the signer must be that address.
7. **Consumed atomically:** `UPDATE … WHERE consumedAt IS NULL`, so of two concurrent verifications
   exactly one succeeds.

Failures map to stable API error codes (`src/contracts/auth.ts`, `AuthErrorCode`):
`WALLET_PROOF_WRONG_BROWSER` 403, `WALLET_PROOF_EXPIRED` 410, `WALLET_PROOF_ALREADY_USED` 409,
`WALLET_PROOF_NOT_SIGNED` 409, `WALLET_PROOF_INVALID` 401, `WALLET_MISMATCH` 403,
`WALLET_KEY_UNSUPPORTED` 422. A Xaman outage or missing credentials is `503`, never "invalid proof".

## Sign-in flow

```text
Browser (/connect)              App API                                   Xaman
 Connect ────────────────► POST /api/auth/challenge ──────────────► create SignIn (force_network)
   ◄── QR + link + httpOnly binding cookie (WalletProof row: hashed token, expiry)
 user approves in Xaman
 poll ───────────────────► GET  /api/wallet/sign-requests/:id ─────► status (B's route)
 SIGNED ─────────────────► POST /api/auth/verify {signRequestId} ──► fetch signed result + blob
                             verify (1–7), consume, link wallet, session
   ◄── session cookie (if new) · binding cookie cleared
```

What `/api/auth/verify` does with a verified wallet:

| Situation | Result |
|---|---|
| Signed out, wallet unknown | New account (role not chosen yet) + session. **201**, `needsOnboarding: true`, and the UI goes to `/onboarding`. |
| Signed out, wallet already linked | Signs in to that account. **200**. |
| Signed in, wallet unlinked or already yours | Links the wallet to your account and marks **this session** as proven. **200**. |
| Signed in, wallet belongs to another account | **409** `WALLET_LINKED_TO_OTHER_ACCOUNT`. Sign out first. |

- **Which sessions see the wallet:** the proving session records it in `Session.walletAddress`.
  Other sessions of a **real** account also see its verified, still-linked wallet (the XRPL-010
  contract). Other sessions of a shared **demo persona** don't: each demoer has to prove their own wallet.
- **Disconnect** in the wallet panel signs out. `POST /api/auth/logout { "forgetWallet": true }` also
  unlinks the wallet from the account.

## Check-in approval (Agent D)

Gate check-in uses its own Xaman SignIn flow, built by Agent D in `src/features/checkin/xaman-proof.ts`.
Each check-in sign-in is tied to one challenge by an HMAC token, and D's store accepts each proof
once. If D wants the extra local signature check, `verifyXamanSignInBlob()` from
`src/lib/auth/wallet-proof.ts` can be reused on `getSignedSignIn(id).signedHex`.

## Limitations

- **Regular keys and multi-signing are not supported** (`WALLET_KEY_UNSUPPORTED`): the signing key must
  be the account's master key. Supporting regular keys needs a validated `account_info` lookup of
  `RegularKey` through Agent B's read service.
- Verification relies on Xaman's reported account **and** the local signature check. A compromised
  Xaman platform could still decline to sign, but it can't make the server accept a signature that
  doesn't verify.
- Proof rows aren't purged yet (`expiresAt` is indexed for a later cleanup job).
- No rate limiting on `/api/auth/challenge`. Each call creates a Xaman payload under the app's quota.

## Manual test (Testnet)

1. Put `XAMAN_API_KEY` / `XAMAN_API_SECRET` in `.env` (see `docs/xrpl/wallet.md`).
2. Fund a throwaway Testnet account: `npm run xrpl:dev-wallet -- my-xaman`. The seed goes to the
   git-ignored `.xrpl-dev-wallets.local.json`. Import it into Xaman (Add account → Import → Family seed).
3. In Xaman, switch the node to **Testnet** (Settings → Advanced → Node).
4. `npm run dev`, open `/connect`, press **Connect with Xaman**, scan and approve. A new wallet goes to
   `/onboarding`, and the header then shows your name and address.
