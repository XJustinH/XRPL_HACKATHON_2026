# src/lib/auth — Agent A

Sessions and onboarding (XRPL-010). Wallet-control proof (XRPL-012) and role
enforcement (XRPL-013) build on this module.

## Using a session

| Where | Call | Result |
|---|---|---|
| Route handler that needs a user | `await requireSession(req)` | `AuthSession`, or throws `401 UNAUTHENTICATED` |
| Route handler where sign-in is optional | `await getRequestSession(req)` | `AuthSession \| null` |
| Server Component (page, layout) | `await getCurrentSession()` | `AuthSession \| null`; renders signed out if the DB is unreachable |
| UI code using the integration ports | `sessionPort` from `session-port.ts` | implements `SessionPort` in `src/features/integration/ports.ts` |

`AuthSession` has `userId`, `displayName`, `role`, `onboardedAt`, `isDemo`, `method`,
`expiresAt` and `walletAddress`.

- **A session is not proof of wallet control.** `walletAddress` is non-null only for a
  wallet link verified by a wallet-signed challenge (XRPL-012). Until then it is always `null`.
- **Hidden navigation is not authorisation.** Check the role on the server for every
  write. XRPL-013 will add shared role guards.

## Routes

| Method | Path | Notes |
|---|---|---|
| POST | `/api/onboarding` | `{ displayName, role: "CUSTOMER" \| "SELLER" }`. New visitor → 201 + session cookie. Signed-in user without a role → 200. Already onboarded → 409 `ALREADY_ONBOARDED`. |
| GET | `/api/me` | User, linked wallets, session info. 401 without a session. |
| PATCH | `/api/me` | `{ displayName }`. Any `role` field → 403 `ROLE_CHANGE_FORBIDDEN`; unknown fields → 400. |
| POST | `/api/auth/logout` | Revokes the session in the DB and clears the cookie. Idempotent. |
| GET | `/api/auth/demo-personas` | Seeded demo accounts (`User.isDemo`). `enabled: false` when demo login is off. |
| POST | `/api/auth/demo-session` | `{ userId }` of a demo persona. 404 for real accounts or when demo login is off. |

UI: `/onboarding` (choose a role, use a demo account, or sign out). `/connect` links to it
until wallet sign-in exists.

## Security properties

- Cookie: random 256-bit token, `HttpOnly`, `SameSite=Lax`, `Path=/`. With an https
  `APP_BASE_URL` it is also `Secure` and named `__Host-xt_session`; otherwise it is `xt_session`.
- Only `SHA-256(token)` is stored (`Session.tokenHash`, CHECK-constrained to a hex digest).
  Sessions last 7 days and logout revokes them server-side, so a replayed cookie gets 401.
- CSRF: `withApiHandler` rejects POST/PUT/PATCH/DELETE that a browser marks cross-site or
  whose `Origin` is not this app (403). Requests without `Origin` (webhooks, curl) pass.
- Roles: only `CUSTOMER` and `SELLER` are self-service, chosen once. `ORGANISER` comes from
  seeded demo accounts or a future admin path. `PATCH /api/me` cannot change a role.
- Demo login (`DEMO_LOGIN_ENABLED`) defaults to on outside production and off in production.
  It can only assume accounts flagged `isDemo`.

## Limitations (hackathon scope)

- No rate limiting on `/api/onboarding`. Anyone can create a profile without a wallet until
  XRPL-012. These profiles cannot sign transactions.
- Expired and revoked session rows are not purged yet. `Session.expiresAt` is indexed for a
  later cleanup job.
- Demo personas are created by the demo seed (XRPL-008, Agent E), which sets `isDemo = true`.
