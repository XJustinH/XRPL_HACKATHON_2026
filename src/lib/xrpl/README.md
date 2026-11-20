# src/lib/xrpl — Agent B

The only module that talks to XRPL or the wallet signing provider (XRPL-006/007/011/014 onward).
Planned exports: `getOwner(nftId)`, `getOffers(nftId)`, `getValidatedTx(hash)`, `createMintIntent`, `createSellOfferIntent`, `acceptOfferIntent`, `cancelOfferIntent`.
Other code must not import `xrpl` or the wallet SDK directly. Publish types in `src/contracts/xrpl.ts`.
