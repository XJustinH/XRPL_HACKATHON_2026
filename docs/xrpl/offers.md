# Ticket sale offers (Agent B, XRPL-029)

Tickets are sold with the XRP Ledger's native NFT offers: the holder creates a **sell offer**
(`NFTokenCreateOffer`) and a buyer accepts it (`NFTokenAcceptOffer`, XRPL-031). The ledger swaps the
NFT and the XRP atomically, so the app never holds a ticket, a key or anyone's money. Code:
`src/lib/xrpl/offers/primary.ts`. Contracts: `src/contracts/xrpl.ts` (Primary sale offers).

## Primary offers (XRPL-029)

The event's owner lists minted tickets for sale on the event's page (`/seller/events/:id`, the
**Mint tickets** panel): **List N for sale at X XRP** runs one Xaman approval per ticket, with progress,
like minting (XRPL-025). Each ticket shows its sale status: for sale, awaiting approval, sold, or not for
sale.

1. **Request.** `POST /api/tickets/:id/primary-offers` with `{}` and an `Idempotency-Key` header.
   - Only the event's owner (`requireEventOwner`), with the wallet this session has proven
     (`requireProvenWallet`). 401 / 404 / 403 otherwise.
   - The ticket must be minted, unsold, and **held by that wallet on a validated ledger**
     (`verifyOwner`), so only NFTs the seller actually owns are listed. 409 otherwise.
   - The price is always the tier's price (`TicketTier.priceDrops`, fixed once tickets are minted).
     A tier priced at 0 XRP cannot be listed (that would be a gift, XRPL-041).
   - A ticket has at most one live primary offer: concurrent requests wait on a lock on the ticket row,
     and the second gets 409.
   - The server builds the transaction: `NFTokenCreateOffer` with `Flags: tfSellNFToken`,
     `Amount` = the price in drops, no `Destination` (anyone may buy), and a memo
     (`xrpl-ticketing/offer`) carrying the app's offer ID. It goes to Xaman as a
     `CREATE_PRIMARY_OFFER` request, which may only be an `NFTokenCreateOffer`. An `NFTOffer` row
     (`PRIMARY`, `PENDING_SIGNATURE`) and a `PENDING` `LedgerTransaction` record it.
2. **Approve.** The seller checks the price in Xaman and approves.
3. **Record.** `GET /api/events/:id/mints` (the seller's panel) and the owner's
   `GET /api/events/:id/primary-offers` reconcile listings awaiting approval:

| Request outcome | Offer | `LedgerTransaction` |
|---|---|---|
| Validated `tesSUCCESS` `NFTokenCreateOffer` (re-checked with `getValidatedTx`) by the seller, and the live offer on the ledger has this NFT, the price and no `Destination` | `ACTIVE` with `offerIndex` and `createTxHash` | `VALIDATED_SUCCESS` |
| Validated, but the offer is already gone from the ledger (taken or cancelled outside the app) | `STALE` | `VALIDATED_SUCCESS` |
| Signed and submitted, not yet validated | unchanged | hash recorded |
| Rejected by the ledger (`tec…`) | `FAILED` | `VALIDATED_FAILURE` |
| Declined, expired, cancelled, or never validated | `FAILED` | `DROPPED` |

Effects apply once (the `LedgerTransaction` is claimed through `appliedAt`), and a late answer never moves
an offer back. A `FAILED` listing frees the ticket to be listed again.

### Listing for buyers

`GET /api/events/:id/primary-offers` returns the event's live primary offers, **cheapest first**
(compared as integer drops): `ACTIVE`, not expired, on minted tickets without `primarySoldAt`. Each item
has Agent C's `OfferPort.PrimaryOffer` fields (`offerId`, `offerIndex`, `nftokenId`, `sellerAddress`,
`amountDrops`, `tierId`) plus `tierName`, `ticketId`, `serial` and `expiresAt`. Server code can call
`listPrimaryOffers(db, eventId)` directly. A draft event's offers are visible only to its owner (404
otherwise). Agent A's inventory (`src/lib/inventory/primary-inventory.ts`, XRPL-020) reads the same
`ACTIVE` primary offers for its "from" price.

A listed offer can still have been taken on the ledger since it was read; accepting one re-checks it
(XRPL-031, XRPL-035).

Verified on XRPL Testnet (20 Nov 2026): a dev seller wallet signed the server-built offer for a minted
ticket at its tier price of 1 XRP,
[`FC663FDE…FAC28993`](https://testnet.xrpl.org/transactions/FC663FDE22AC2722078AED069AAFA2122AC575FD8238852A52CF862CFAC28993)
(`tesSUCCESS`, ledger 22482808). The app recorded it as `ACTIVE` with the ledger's offer index, the ledger
showed the sell offer by the seller for 1,000,000 drops with no destination, and the public listing
returned it.

Limitations:

- Each live offer locks an owner reserve (0.2 XRP on Testnet today) in the seller's account until it is
  accepted or cancelled.
- One approval per ticket, as for minting.
- Primary offers have no expiry. Cancelling a listing is XRPL-042.
