# src/features/wallet — Agent B

Browser side of wallet connection (XRPL-011). Client code only: it talks to the
`/api/wallet/*` routes and never imports `xrpl`, the Xaman SDK or `@/lib/xrpl`
(server-only). The one exception is `@/lib/xrpl/format`, which is pure.

| File | What |
|---|---|
| `wallet-store.ts` | Connected wallet (public address + network) kept in this browser |
| `use-sign-in.ts` | One Xaman sign-in: create, poll, cancel |
| `wallet-connect-panel.tsx` | Connect / connected / disconnect UI, used by `/connect` |

Linking the wallet to a user session with a verified signature is XRPL-012 (Agent A).
It can use `getSignedSignIn()` from `src/lib/xrpl/wallet/sign-requests.ts`.
