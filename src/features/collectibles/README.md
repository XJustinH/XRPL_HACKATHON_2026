# Digital collectibles (XRPL-070 to XRPL-075)

Artist-made NFTs sold as merchandise. **Not tickets**: own tables, own taxon, own memo type, and
nothing here touches `TicketNFT`, `NFTOffer` or `LedgerTransaction`. Full description:
[`docs/collectibles.md`](../../../docs/collectibles.md).

| File | What |
|---|---|
| `storage.ts` | `MediaStorage` interface and the local-disk adapter (`MEDIA_STORAGE_DIR`) |
| `assets.ts` | Upload validation (signature sniffing, size limits, rights declaration) and who may see an asset |
| `listings.ts` | Draft, edit, publish (creates one token per edition), and the views |
| `metadata.ts` | Taxon, flags, memo type, URLs and the metadata JSON |
| `ledger.ts` | Mint, sell offer, purchase, reconciliation and the owned collection. Records only from validated transactions |
| `server.ts` | Production wiring for the ledger services (`collectibleDeps()`); `assetDeps()` is in `assets.ts` |
| `http.ts`, `client-api.ts` | Route and browser helpers (upload with progress) |
| `collectible-ui.tsx` | Media preview, rights notice, on-chain proof, listing card |
| `sections.tsx` | Server components to mount: `SellerCollectiblesSection`, `OwnedCollectiblesSection`, `BrowseCollectiblesSection` |
| `seller-collectibles-manager.tsx`, `buy-collectible.tsx` | Client UI for the seller workspace and the Buy button |
| `collectibles.int.test.ts` | DB tests with storage, Xaman and the ledger faked |

Contracts are in `src/contracts/collectibles.ts` (import it directly; it is not in the contracts barrel).
