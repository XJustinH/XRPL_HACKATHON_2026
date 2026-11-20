# src/features/wallet — Agent B

Browser side of wallet connection and transaction approvals (XRPL-011, XRPL-014). Client code only: it talks to the
`/api/wallet/*` routes and never imports `xrpl`, the Xaman SDK or `@/lib/xrpl`
(server-only). The one exception is `@/lib/xrpl/format`, which is pure.

| File | What |
|---|---|
| `wallet-store.ts` | Connected wallet (public address + network) kept in this browser |
| `use-sign-in.ts` | One Xaman sign-in: create, poll, cancel |
| `wallet-connect-panel.tsx` | Connect / connected / disconnect UI, used by `/connect` |
| `transaction-approval.tsx` | Approve-in-Xaman, submitted, confirmed (explorer link) and failed states for any transaction request (XRPL-014) |
| `test-transaction-check.tsx` | Developer no-op transaction check, shown when the server enables it |
| `styles.ts` | Shared class names on Agent C's design tokens |

Linking the wallet to a user session with a verified signature is XRPL-012 (Agent A).
It can use `getSignedSignIn()` from `src/lib/xrpl/wallet/sign-requests.ts`.
