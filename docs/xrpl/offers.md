# Ticket sale offers and purchases (Agent B, XRPL-029, XRPL-031)

Tickets are sold with the XRP Ledger's native NFT offers: the holder creates a **sell offer**
(`NFTokenCreateOffer`) and a buyer accepts it (`NFTokenAcceptOffer`, XRPL-031). The ledger swaps the
NFT and the XRP atomically, so the app never holds a ticket, a key or anyone's money. Code:
`src/lib/xrpl/offers/primary.ts` and `src/lib/xrpl/offers/purchase.ts`. Contracts: `src/contracts/xrpl.ts` (Primary
sale offers, Primary purchases).

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

## Buying a ticket (XRPL-031)

The buyer picks a ticket type on the event page (Agent C's ticket selection, XRPL-019), which leads to
`/events/:id/purchase?tier=…`. That page confirms the cheapest live offer for the tier and shows the full
amount and the wallet's readiness (Agent C, XRPL-030). When the wallet is ready, `BuyTicket`
(`src/features/purchase/buy-ticket.tsx`) finishes the purchase.

1. **Request.** `POST /api/offers/:id/accept-intent` with `{}` and an `Idempotency-Key` header.
   - The buyer is the session's proven wallet (`requireProvenWallet`: 403 `WALLET_NOT_VERIFIED`).
     Without one, the page asks the buyer to connect instead of failing a sale.
   - The offer must be an `ACTIVE` primary offer on an unsold ticket of a published event (404 / 409),
     and the buyer can't be the seller.
   - The buyer must be able to pay: spendable XRP (balance minus reserves) covers the price plus one
     reserve increment for the NFT page the ticket may need (`getWalletReadiness`). 409 with the reason
     otherwise.
   - **The live offer is re-checked on the ledger**: it must still exist with this price, owner and no
     `Destination`, and the seller must still hold the NFT. If not, the offer becomes `STALE` and the
     buyer gets 409 ("just sold or taken off sale").
   - **One purchase in flight per ticket.** A hold (a `PENDING` `NFTokenAcceptOffer` `LedgerTransaction`)
     is taken under a lock on the offer row, and a second buyer gets 409 until it settles. Earlier
     attempts are settled first, so a declined or expired one doesn't block anyone. Agent A's inventory
     counts the hold as a purchase in flight (`pending`).
   - The server builds `NFTokenAcceptOffer` (`Account` = the buyer, `NFTokenSellOffer` = the offer index,
     and a memo `xrpl-ticketing/purchase` with the offer ID) and sends it to Xaman as an
     `ACCEPT_PRIMARY_OFFER` request, which may only be an `NFTokenAcceptOffer`.
2. **Approve.** The buyer checks the price in Xaman and approves. The ledger swaps the NFT and the XRP.
3. **Record.** `GET /api/offers/:id` settles purchases in flight. The buy button reads it when the
   approval ends, and the seller's panel settles the event's purchases when it loads.

| Purchase outcome | Offer | Ticket | `LedgerTransaction` |
|---|---|---|---|
| Validated `tesSUCCESS` `NFTokenAcceptOffer` by the buyer for this NFT (re-checked with `getValidatedTx`) | `ACCEPTED`, with `acceptTxHash` and `acceptedByAddress` from the ledger | `primarySoldAt` = ledger close time; cached owner = the buyer (checked with `verifyOwner`) | `VALIDATED_SUCCESS` |
| Signed and submitted, not yet validated | unchanged (`purchasePending`) | unchanged | hash recorded |
| Declined, expired, cancelled or failed, **and the offer is still live on the ledger** | stays `ACTIVE`: the ticket is still for sale | unchanged | `DROPPED` / `VALIDATED_FAILURE` |
| Failed, and the offer is gone from the ledger (bought or withdrawn elsewhere) | `STALE` | unchanged | `VALIDATED_FAILURE` |

Effects apply once (`appliedAt`). Agent A's inventory (XRPL-020) counts the ticket as sold from
`primarySoldAt`, and the ticket stores the sale's hash in `primarySaleTxHash`. Sales made outside the app are
recorded from their tx hash by Agent A's `POST /api/ledger/transactions/:hash/reconcile` (XRPL-032).

Verified on XRPL Testnet (20 Nov 2026): a dev buyer wallet bought the ticket listed above through the server
path, signing exactly the transaction the server built:
[`7145B785…067B633D`](https://testnet.xrpl.org/transactions/7145B78538A2B9E861EC79B4DF7C3AEC12504D3565DAB3848A49A882067B633D)
(`tesSUCCESS`, ledger 22483122).

- **Recorded:** the offer became `ACCEPTED` and the ticket sold at the ledger close time, with the buyer as its cached owner.
- **On the ledger:** the buyer holds the NFT, the seller no longer does, and the sell offer is gone. The buyer paid 1 XRP plus a 12-drop fee.
- **Inventory:** Agent A's inventory showed the ticket as pending while the purchase was held, then sold, with 9 remaining.

Limitations:

- One ticket per purchase. Choosing a quantity is part of Agent C's ticket selection (XRPL-019).
- A hold lasts until the buyer's Xaman request settles (it expires after 10 minutes unopened), so an
  abandoned purchase blocks that one ticket for up to 10 minutes.
- A sale made straight from the ledger with another wallet app is recorded once its transaction hash is
  reconciled (`POST /api/ledger/transactions/:hash/reconcile`, XRPL-032). Until then the offer is marked
  `STALE` the next time anyone tries to buy it in the app.

## Holder offers: resale, private sale, gift (XRPL-036, 039, 040, 041)

A ticket's current holder can offer it on, signing an `NFTokenCreateOffer` (sell) in their own Xaman wallet.
Code: `src/lib/xrpl/offers/holder.ts`. Screens (ticket page, offer page, resale listings):
`src/features/transfers/README.md`.

| Route | Body | Offer on the ledger | Who can accept |
|---|---|---|---|
| `POST /api/tickets/:id/resale-offers` | `{ amountDrops }` | the holder's price, no `Destination` | anyone; the app lists it only while the resale rule allows (XRPL-037) |
| `POST /api/tickets/:id/private-offers` | `{ destination, amountDrops }` | the holder's price, `Destination` = recipient | only the recipient: the ledger rejects anyone else |
| `POST /api/tickets/:id/gift-offers` | `{ destination }` | `Amount: "0"`, `Destination` = recipient | only the recipient |

All three take an `Idempotency-Key` header and return 201 `{ data: { offer, request } }`, where `request` is
what the holder approves in Xaman.

**Rules** (409 unless noted):
- The holder must be the session's proven wallet (403 `WALLET_NOT_VERIFIED`).
- That wallet must hold the NFT on a validated ledger.
- The ticket must have had its primary sale. The organiser's unsold tickets go through primary offers.
- Tickets that have been checked in, or whose event has finished, can't be offered.
- A ticket has one live offer at a time.
- A resale price is checked against the in-app price cap (XRPL-095) before anything is signed.
- A zero price is only possible as a gift, which must name its recipient. The holder can't name themselves.

**Recording:** offers become `ACTIVE` exactly like primary offers, through `reconcileOfferCreation`.
The ledger's offer must match the recorded price and `Destination`. `GET /api/offers/:id` records a new
offer when it is read.

**Accepting** (`POST /api/offers/:id/accept-intent`, the same flow as buying a primary ticket):
- **Resale** offers are found only through the resale rule's `getPublicOffer`, so a direct API call can't buy
  a listing the app hides. Without the rule wired in, resale offers can't be bought here.
- **Private sales and gifts** are visible only to the wallet they name. The ledger enforces the same
  restriction.
- **Used tickets:** a ticket that has been checked in can't change hands, even through an offer made
  before the check-in (409). The resale rule stops listing it too.
- **On success:** a validated transfer moves the ticket to its new owner (`cachedOwnerAddress`).
  `primarySoldAt` stays as it was. Organiser metrics count private transfers and gifts separately from
  resales (XRPL-076).

**Limitations:**
- A gift or private sale can't be reversed once accepted. The ticket page asks for confirmation before
  creating a gift.
- Cancelling an open offer is XRPL-042.
- Offers made by a previous holder stay recorded as they were until reconciliation (XRPL-043). The ledger
  no longer lets anyone accept them once the NFT has moved.

Verified on XRPL Testnet (21 Nov 2026) by the live lifecycle suite, with each transaction recorded
`VALIDATED_SUCCESS` from the ledger:
- **Private sale:** offered
  [`29DBDFA4…55A63458`](https://testnet.xrpl.org/transactions/29DBDFA433EAAC0885A9A80E9096F7B26F3D83084D11C66EDDF54C5855A63458)
  and accepted by the named friend
  [`51B4D2BD…E20288F9`](https://testnet.xrpl.org/transactions/51B4D2BDD34E004607D4A662EC5F3A9283A19176B64614664F3D8C2EE20288F9).
  A direct attempt by another wallet was refused by the ledger with a `tec` result.
- **Gift back:** offered
  [`81C4B63E…19CE8DCA`](https://testnet.xrpl.org/transactions/81C4B63EBD45C5D1A0892F7257C899588F897E4719D9163345F6E88B19CE8DCA)
  and accepted
  [`11D3DF8C…80252ABB`](https://testnet.xrpl.org/transactions/11D3DF8C85CF817989FC5B0CBD5858840F8916D647DB483B83AE49D680252ABB).

