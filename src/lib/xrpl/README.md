# src/lib/xrpl — Agent B

The only module that talks to XRPL or the wallet signing provider. Other code imports from
`@/lib/xrpl` and never imports `xrpl` or the wallet SDK directly. Types are published in
`src/contracts/xrpl.ts`. Setup and rules: [docs/xrpl/testnet.md](../../../docs/xrpl/testnet.md).

| File | What | Issue |
|---|---|---|
| `config.ts` | Network settings from env, Mainnet guard (`loadXrplConfig`) | XRPL-006 |
| `client.ts` | Connection manager: failover, timeouts, `network_id` check on every node | XRPL-006 |
| `errors.ts` | `XrplServiceError` and its stable codes | XRPL-006 |
| `explorer.ts` | Validated explorer links for transactions, accounts, NFTs | XRPL-006 |
| `tools/` | Developer CLIs run via `npm run xrpl:*`. Never imported by the app | XRPL-006 |

Next: `getOwner(nftId)`, `getOffers(nftId)`, `getValidatedTx(hash)` (XRPL-007), then
`createMintIntent`, `createSellOfferIntent`, `acceptOfferIntent`, `cancelOfferIntent` (XRPL-014 onward).
