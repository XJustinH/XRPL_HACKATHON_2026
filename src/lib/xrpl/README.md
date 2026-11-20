# src/lib/xrpl — Agent B

The only module that talks to XRPL or the wallet signing provider. Other code imports from
`@/lib/xrpl` and never imports `xrpl` or the wallet SDK directly. Types are published in
`src/contracts/xrpl.ts`. Docs: [testnet.md](../../../docs/xrpl/testnet.md) (setup, Mainnet guard) and
[read-service.md](../../../docs/xrpl/read-service.md) (reads, routes, error mapping).

| File | What | Issue |
|---|---|---|
| `config.ts` | Network settings from env, Mainnet guard (`loadXrplConfig`) | XRPL-006 |
| `client.ts` | Connection manager: failover, timeouts, `network_id` check on every node | XRPL-006 |
| `errors.ts` | `XrplServiceError` and its stable codes | XRPL-006 |
| `explorer.ts` | Explorer links for transactions, accounts, NFTs | XRPL-006 |
| `query.ts` | `getOwner`, `verifyOwner`, `getOffers`, `getTransaction`, `getValidatedTx`, `getAccountNfts`, `getAccountInfo`, `getFeeEstimateDrops` | XRPL-007 |
| `http.ts` | Maps service errors onto the shared API envelope | XRPL-007 |
| `tools/` | Developer CLIs run via `npm run xrpl:*`. Never imported by the app | XRPL-006/007 |

Routes owned here: `src/app/api/xrpl/**` (status, wallet NFTs, transaction status).

Next: `createMintIntent`, `createSellOfferIntent`, `acceptOfferIntent`, `cancelOfferIntent` and wallet
sign requests (XRPL-011/014 onward).
