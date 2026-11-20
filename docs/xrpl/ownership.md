# Ticket ownership (Agent B, XRPL-028)

Who holds a ticket is a fact on the XRP Ledger. The app never decides it, and it never shows a ticket as
owned unless the owner was read from a **validated** ledger. `TicketNFT.cachedOwnerAddress` is only a
display mirror that every check refreshes. Code: `src/lib/xrpl/tickets/ownership.ts`.
Contract: `TicketOwnership` in `src/contracts/xrpl.ts`.

## One ticket

`GET /api/tickets/:id/ownership` (public; 404 for an unknown ticket) returns `TicketOwnership`:

| `status` | Meaning | Show it as |
|---|---|---|
| `VERIFIED` | `ownerAddress` was read from a validated ledger (`ledgerIndex`) | The owner. "In your wallet" when `ownedByViewer` (the session's proven wallet holds it) |
| `PENDING` | It couldn't be verified: the ledger was unreachable, the answer wasn't from a validated ledger, or the NFT moved to a wallet the app hasn't seen | "Ownership pending", with `detail`. **Never as owned** |
| `NOT_MINTED` | The ticket has no NFT yet | Not minted |
| `BURNED` | The NFT no longer exists | No longer exists |

- **Lookup.** Clio `nft_info` (`getOwner`) answers directly (Testnet has a public Clio node, configured
  by default). Without Clio, or before Clio has indexed a new NFT, the app checks the wallets it knows
  on rippled (`verifyOwner`): the cached owner, buyers through the app, and the issuer.
- **Change detection.** `previousOwnerAddress` is the owner on record before the check, and `changed` is
  true when the verified owner differs: a sale or a transfer happened, possibly outside the app.
- **Cache refresh.** A verified answer updates `cachedOwnerAddress`, `ownerSyncStatus` (`SYNCED`),
  `ownerSyncedAt` and `ownerSyncLedgerIndex`. An answer from an older ledger never overwrites a newer
  one. `PENDING` keeps the cached owner but flags it (`ERROR` when the ledger was unreachable, `STALE`
  when the NFT moved somewhere unknown).

`OwnershipBadge` (`src/features/tickets/ownership-badge.tsx`) shows this status for one ticket: "In your
wallet", "Held by r…", or "Ownership pending" with the reason, plus a note when the ticket changed hands.

## A wallet's tickets, and Agent C's ticket screens

For Agent C's My tickets (XRPL-033) and ticket view (XRPL-034), server code calls these. They implement
the `LedgerReadPort` reads in `src/features/integration/ports.ts` and return C's `TicketView` and
`LedgerProof` types.

- `listTicketsForOwner(deps, { address, viewerAddress })` reads the wallet's NFTs from a validated ledger
  (`account_nfts`, up to 10,000) and returns the tickets among them, so every ticket listed is verified.
  It refreshes the cache both ways: listed tickets now show this wallet, and tickets the app thought the
  wallet held but it no longer does become `STALE` (sold or transferred away). A wallet with no account on
  the network holds nothing.
- `getTicketView(deps, { ticketId, viewerAddress })` returns `{ ticket, ownership }`. `ticket` is the
  full view only when ownership is `VERIFIED`; otherwise show `ownership.status`.
- `getLedgerProof(deps, nftokenId)` and `getTicketOwner(deps, nftokenId)` cover the other two reads.
- In a `TicketView`, `ledger.lastTransferTxHash` is the latest validated purchase through the app.

Wire them with `mintingDeps()` from `src/lib/xrpl/tickets/server.ts`.

## Verified on XRPL Testnet (20 Nov 2026)

1. A ticket bought through the app (XRPL-031) read as `VERIFIED`, held by the buyer, through Clio.
2. The buyer then gave the NFT to another wallet directly on the ledger, outside the app:
   [`3F341D9F…DD57E8B7`](https://testnet.xrpl.org/transactions/3F341D9F74F5C27036C6B1D93B647F461D756E0A00ACDAF5A1021618DD57E8B7).
3. The next check reported the new owner with `changed: true`, and no longer as owned by the buyer.
4. The buyer's list became empty, and the receiving wallet's list included the ticket.

## Limitations

- A ticket that moves to a wallet the app has never seen shows as `PENDING` when Clio is unavailable,
  until that wallet's tickets are read.
- Checks run when a ticket or wallet is viewed. A background sweep of all tickets is part of XRPL-032's
  reconciliation.
