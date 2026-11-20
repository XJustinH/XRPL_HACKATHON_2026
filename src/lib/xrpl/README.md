# src/lib/xrpl — Agent B

The only module that talks to XRPL or the wallet signing provider. Server-only: other code imports
from `@/lib/xrpl` and never imports `xrpl` or the wallet SDK directly. Client components may import
only `@/lib/xrpl/format`. Types are published in `src/contracts/xrpl.ts`.

Docs:

- [testnet.md](../../../docs/xrpl/testnet.md): setup and the Mainnet guard
- [read-service.md](../../../docs/xrpl/read-service.md): reads, routes and error mapping
- [wallet.md](../../../docs/xrpl/wallet.md): Xaman wallet connection

| File | What | Issue |
|---|---|---|
| `config.ts` | Network settings from env, Mainnet guard (`loadXrplConfig`) | XRPL-006 |
| `client.ts` | Connection manager: failover, timeouts, `network_id` check on every node | XRPL-006 |
| `errors.ts` | `XrplServiceError` and its stable codes | XRPL-006 |
| `explorer.ts` | Explorer links for transactions, accounts, NFTs | XRPL-006 |
| `query.ts` | `getOwner`, `verifyOwner`, `getOffers`, `getTransaction`, `getValidatedTx`, `getAccountNfts`, `getAccountInfo`, `getFeeEstimateDrops`, `getReserves` | XRPL-007 |
| `http.ts` | Maps service errors onto the shared API envelope | XRPL-007 |
| `format.ts` | `formatDropsAsXrp` (pure, client-safe) | XRPL-011 |
| `wallet/xaman.ts` | Xaman platform API client (server-only, uses the API secret) | XRPL-011 |
| `wallet/sign-requests.ts` | Sign-in requests: create, status, cancel, `getSignedSignIn` for XRPL-012 | XRPL-011 |
| `wallet/readiness.ts` | Spendable balance and blockers for a wallet (`WalletReadiness`) | XRPL-011 |
| `tools/` | Developer CLIs run via `npm run xrpl:*`. Never imported by the app | XRPL-006/007 |

Routes owned here: `src/app/api/xrpl/**` (status, wallet NFTs, transaction status) and
`src/app/api/wallet/**` (sign requests, readiness). The browser side lives in `src/features/wallet/`.

Next: transaction sign requests (XRPL-014), then `createMintIntent`, `createSellOfferIntent`,
`acceptOfferIntent` and `cancelOfferIntent`.
