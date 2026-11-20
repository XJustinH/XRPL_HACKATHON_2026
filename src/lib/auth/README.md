# src/lib/auth — Agent A

Sessions and onboarding (XRPL-010), wallet sign-in / wallet-control proof (XRPL-012) and
permissions (XRPL-013, [docs/auth/permissions.md](../../../docs/auth/permissions.md)). Wallet design and verification details:
[docs/auth/wallet-sign-in.md](../../../docs/auth/wallet-sign-in.md).

## Using a session

| Where | Call | Result |
|---|---|---|
| Route handler that needs a user | `await requireSession(req)` | `AuthSession`, or throws `401 UNAUTHENTICATED` |
| Route handler where sign-in is optional | `await getRequestSession(req)` | `AuthSession \| null` |
| Server Component (page, layout) | `await getCurrentSession()` | `AuthSession \| null`; renders signed out if the DB is unreachable |
| UI code using the integration ports | `sessionPort` from `session-port.ts` | implements `SessionPort` in `src/features/integration/ports.ts` |
| Seller-only action (create an event) | `requireEventManager(session)` | 403 `ONBOARDING_REQUIRED` / `ROLE_REQUIRED` |
| Event / tier / inventory write, mint, primary offers | `await requireEventOwner(db, session, eventId)` | 404 unknown event, 403 `NOT_EVENT_OWNER` |
| Gate scanner, organiser dashboards | `isEventOwner(db, userId, eventId)` / `eventAccess(db)` | `boolean` / an `OrganiserAccess` |
| Buying, accepting offers, check-in codes | `requireProvenWallet(session)` | the wallet address, or 403 `WALLET_NOT_VERIFIED` |
| Resale / private / gift offers | `await requireTicketOwner(db, session, ticketId)` | ledger-verified holder, or 404 / 409 / 403 / 503 |

`AuthSession` has `userId`, `displayName`, `role`, `onboardedAt`, `isDemo`, `method`,
`expiresAt`, `walletAddress` and `walletVerifiedAt`.

- **`walletAddress` is the account's proven wallet.** It is either proven in this session, or (real
  accounts only) verified earlier by a wallet-signed proof and still linked. Shared demo personas count
  only a proof made in this session, so nobody inherits another demoer's wallet. `null` means wallet
  control is not proven. Value-moving actions are still signed in the user's own wallet.
- **Hidden navigation is not authorisation.** Every write calls a guard from `permissions.ts` on
  the server (see the table above and [docs/auth/permissions.md](../../../docs/auth/permissions.md)).

## Routes

| Method | Path | Notes |
|---|---|---|
| POST | `/api/onboarding` | `{ displayName, role: "CUSTOMER" \| "SELLER" }`. New visitor → 201 + session cookie. Signed-in user without a role → 200. Already onboarded → 409 `ALREADY_ONBOARDED`. |
| GET | `/api/me` | User, linked wallets, session info (incl. the proven `walletAddress`). 401 without a session. |
| PATCH | `/api/me` | `{ displayName }`. Any `role` field → 403 `ROLE_CHANGE_FORBIDDEN`; unknown fields → 400. |
| POST | `/api/auth/challenge` | Starts a wallet sign-in: one-time, expiring Xaman SignIn bound to this browser (httpOnly cookie). Optional `{ address }` → only that wallet may finish. 201 `SignRequest`. |
| POST | `/api/auth/verify` | `{ signRequestId }` from the same browser → verifies and consumes the proof, then signs in / links the wallet. 201 new account (needs onboarding) or 200. |
| POST | `/api/auth/logout` | Revokes the session in the DB and clears the cookie. Optional `{ forgetWallet: true }` unlinks the session's wallet. Idempotent. |
| GET | `/api/auth/demo-personas` | Seeded demo accounts (`User.isDemo`). `enabled: false` when demo login is off. |
| POST | `/api/auth/demo-session` | `{ userId }` of a demo persona. 404 for real accounts or when demo login is off. |

UI: `/connect` (Agent B's wallet panel, which signs in with Xaman through challenge → verify), and
`/onboarding` (choose a role, use a demo account, or sign out).

## Security properties

- Cookie: random 256-bit token, `HttpOnly`, `SameSite=Lax`, `Path=/`. With an https
  `APP_BASE_URL` it is also `Secure` and named `__Host-xt_session`; otherwise it is `xt_session`.
- Only `SHA-256(token)` is stored (`Session.tokenHash`, CHECK-constrained to a hex digest).
  Sessions last 7 days and logout revokes them server-side, so a replayed cookie gets 401.
- Wallet proofs: single use, 10-minute window, bound to the requesting browser (only the
  SHA-256 of the binding token is stored), signature verified locally, and the `xaman-signin` memo
  must name the request. Replays, other browsers, wrong wallets and expired requests are rejected.
- CSRF: `withApiHandler` rejects POST/PUT/PATCH/DELETE that a browser marks cross-site or
  whose `Origin` is not this app (403). Requests without `Origin` (webhooks, curl) pass.
- Roles: only `CUSTOMER` and `SELLER` are self-service, chosen once. `ORGANISER` comes from
  seeded demo accounts or a future admin path. `PATCH /api/me` cannot change a role.
- Demo login (`DEMO_LOGIN_ENABLED`) defaults to on outside production and off in production.
  It can only assume accounts flagged `isDemo`.

## Limitations (hackathon scope)

- No rate limiting on `/api/onboarding` or `/api/auth/challenge`.
- Accounts that sign with a regular key, or by multi-signing, can't sign in yet (422).
- Expired and revoked session and proof rows are not purged yet (`expiresAt` is indexed for a
  later cleanup job).
- Demo personas are created by the demo seed (XRPL-008, Agent E), which sets `isDemo = true`.
