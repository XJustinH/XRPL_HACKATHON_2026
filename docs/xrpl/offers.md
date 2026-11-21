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
| Validated, but the ticket was checked in meanwhile | `ACTIVE`: it is live on the ledger. It can't be bought or listed in the app, and its owner can cancel it | `VALIDATED_SUCCESS` |
| Xaman no longer has the request, 15 minutes on, but it was signed (its transaction hash was recorded) | settled from that transaction: as above for `tesSUCCESS` or a `tec…` result | as above |
| The request can't be signed or followed any more 15 minutes on (never recorded because the server stopped in between, unsigned and forgotten by Xaman, or its transaction never validated), and no matching offer is on the ledger | `FAILED` | `DROPPED` when one was recorded |
| The same, but a matching offer is on the ledger (it was signed) | unchanged and logged: it stays awaiting approval until that ledger offer is gone (its owner cancels it from their wallet). The next read then gives `FAILED`, as in the row above | unchanged |

Effects apply once (the `LedgerTransaction` is claimed through `appliedAt`), and a late answer never moves
an offer back. A `FAILED` listing frees the ticket to be listed again. These rows apply to every kind of
offer the app creates (primary, resale, private sale, gift). Xaman's 10-minute expiry only limits opening
a request: one opened in time can still be signed later. The 15-minute rule doesn't cover that yet for
offers and purchases, as it does for mints
([ticket-nft.md](ticket-nft.md#failures-and-retries-xrpl-027)).

### Listing for buyers

`GET /api/events/:id/primary-offers` returns the event's live primary offers, **cheapest first**
(compared as integer drops): `ACTIVE`, not expired, on minted tickets without `primarySoldAt`. Each item
has Agent C's `OfferPort.PrimaryOffer` fields (`offerId`, `offerIndex`, `nftokenId`, `sellerAddress`,
`amountDrops`, `tierId`) plus `tierName`, `ticketId`, `serial`, `expiresAt` and `purchasePending`. Server
code can call `listPrimaryOffers(db, eventId, { viewerAddress })` directly. A draft event's offers are
visible only to its owner (404 otherwise). Agent A's inventory (`src/lib/inventory/primary-inventory.ts`,
XRPL-020) reads the same `ACTIVE` primary offers for its "from" price.

`purchasePending` is true while another buyer's purchase of that ticket is in flight (XRPL-035). Those
offers are listed after the free ones at the same price, so the next buyer is given a ticket they can buy.
The reader's own purchase in flight doesn't count (`viewerAddress`, the session's proven wallet), and
neither does one started more than 15 minutes ago.

A listed offer can still have been taken on the ledger since it was read. The purchase page confirms the
one it shows against the ledger, and accepting one re-checks it (XRPL-031, XRPL-035).

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
- Primary offers have no expiry. The seller can cancel a listing through the API (see
  [Cancelling an offer](#cancelling-an-offer-xrpl-042)). The organiser screens don't offer it yet.

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
   - **Earlier attempts are settled first.** One that validated records its sale, so this buyer is told
     the ticket is sold. A declined or expired one frees the ticket.
   - **The live offer is re-checked on the ledger**: it must still exist with this price, owner and no
     `Destination`, and the seller must still hold the NFT. If not, the offer becomes `STALE` and the
     buyer gets 409 ("just sold or taken off sale").
   - **One purchase in flight per ticket.** A hold (a `PENDING` `NFTokenAcceptOffer` `LedgerTransaction`)
     is taken under a lock on the offer row, and a second buyer gets 409 until it settles. Agent A's
     inventory counts the hold as a purchase in flight (`pending`).
   - Every 409 names its reason in `details.reason` (`PurchaseRefusalReason`, see
     [Competing buyers](#competing-buyers-xrpl-035)).
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
`primarySoldAt`, and the ticket stores the sale's hash in `primarySaleTxHash`. Sales, resales, private sales and
gifts accepted outside the app are recorded from their tx hash by Agent A's
`POST /api/ledger/transactions/:hash/reconcile` (XRPL-032, XRPL-043).

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
  abandoned purchase keeps that one ticket from other buyers for up to 15 minutes. They are offered the
  tier's other tickets meanwhile (XRPL-035).
- A sale made straight from the ledger with another wallet app is recorded once its transaction hash is
  reconciled (`POST /api/ledger/transactions/:hash/reconcile`, XRPL-032/043). Until then the offer is marked
  `STALE` the next time anyone opens its purchase page or tries to buy it in the app.

### Competing buyers (XRPL-035)

Several buyers can want the same ticket, in the app or straight on the ledger. Only one can get it. The
others must never be shown a success, and should be pointed at a ticket they can still buy.

**What is shown as available**

- **Closed offers are never listed.** `EXPIRED`, `ACCEPTED`, `CANCELLED`, `STALE` and `FAILED` offers, and
  `ACTIVE` ones past their expiry or on a sold ticket, are left out of `listPrimaryOffers`. Agent D's
  resale listing does the same for resale offers.
- **A ticket being bought is passed over.** While another buyer's purchase is in flight, the ticket type's
  next free ticket is offered instead (`purchasePending`, above). If every ticket on sale is held, the
  ticket type reads "Being bought right now" on the event page, and the purchase page says the ticket
  comes back on sale if that buyer doesn't finish, with **Check again**.
- **The purchase page checks the ledger before it shows a ticket** (`selectTierForPurchase`,
  `src/features/events/purchase-selection.ts`, calling `refreshOfferForSale`):
  - purchases in flight are settled first, so a sale that validated is recorded;
  - an offer the ledger no longer backs is closed (`STALE`, or `EXPIRED` past its expiry) and the next one
    is picked, for up to three offers per page view;
  - if the ledger can't be read, the offer is shown as last recorded. Buying re-checks it.
- Holder offers (`/offers/:id`) are checked against the ledger the same way before they are shown
  ([Cancelling an offer](#cancelling-an-offer-xrpl-042)).

**What the buyer who loses is told**

| When | Server | What the buyer sees |
|---|---|---|
| Asking to buy a closed offer, or one whose sale has just been recorded | 409 `OFFER_CLOSED` | "This ticket is no longer for sale", and **See what's available now** |
| Asking to buy an offer the ledger no longer has | 409 `OFFER_GONE`; the offer becomes `STALE` | "This ticket was just sold or taken off sale", and **See what's available now** |
| Asking to buy while another buyer is approving | 409 `PURCHASE_IN_FLIGHT` | "Someone is buying this ticket right now", and **See what's available now** |
| Approving after someone else took the ticket (`tecOBJECT_NOT_FOUND`) | the attempt is `VALIDATED_FAILURE`, the offer `STALE` | "Someone else got this ticket first, so your purchase didn't go through. You paid only the small network fee, not the ticket price", and **See what's available now** |
| Declining or letting the request expire after the ticket went elsewhere | the attempt is `DROPPED` | "This ticket went to someone else before you approved. You weren't charged", and **See what's available now** |

- **See what's available now** refreshes the purchase page, which picks the ticket type's next ticket or
  says it has sold out. It replaces **Try again**, which could only fail the same way.
- A refusal about the buyer rather than the ticket keeps **Try again**: `OWN_PURCHASE_IN_FLIGHT` (their
  own purchase is waiting in Xaman), `WALLET_NOT_READY`, `OWN_OFFER` and `TICKET_USED`.
- On a holder's offer page, a buyer who loses a resale ticket gets a link to the event's other resale
  tickets.
- A ticket is only ever shown as bought from the buyer's own validated `NFTokenAcceptOffer`.

Limitations:

- The event page lists offers from the app's records without reading the ledger. An offer taken outside
  the app is still listed there until someone opens its purchase page.
- A buyer whose purchase is in flight elsewhere (another tab or device) sees that ticket as available. Asking
  again is refused with `OWN_PURCHASE_IN_FLIGHT`.
- Purchase requests carry no `LastLedgerSequence` yet, so one opened in Xaman before it expired can still be
  signed after its hold was released. The ledger then decides who gets the ticket, and the other buyer
  is told as above.

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
- Tickets that have been checked in, or whose event has finished, can't be offered. The check-in is
  checked again under the ticket's lock, so one recorded meanwhile still counts.
- A holder has one live offer per ticket at a time. The ticket's earlier offers are settled first:
  one awaiting approval is reconciled, and an open one is checked against the ledger. So a declined,
  expired, or vanished offer doesn't block a new one.
- An earlier holder's offers can't be filled once the NFT has moved. Their open offer is closed as `STALE`
  when the new holder makes an offer, unless a purchase or cancellation of it is in flight: that records
  its own outcome. One still awaiting approval is left to settle: the ledger would reject it now, so it
  ends `FAILED`.
- The wallet must have the owner reserve a new offer locks (0.2 XRP on Testnet), plus one increment for
  each of its other offers made in the last 15 minutes and still awaiting approval. Otherwise the ledger
  would reject the offer with `tecINSUFFICIENT_RESERVE` and still charge the fee. The check is repeated
  as the offer is recorded, one offer at a time per wallet, so two offers made at once can't both pass
  on the same spare XRP.
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
- An offer whose request was lost after it was signed stays awaiting approval in the app, and the ticket
  page keeps showing it as waiting in Xaman. The app can't cancel it, because it never recorded the
  ledger offer. So the ticket can't be offered again here, and the ledger offer can still be bought
  directly. To free the ticket, its owner cancels that sell offer from their wallet
  (`NFTokenCancelOffer`). The next read of the ticket page or the offer then finds no matching offer and
  marks it `FAILED`.
- An offer made by a previous holder stays recorded until it's next read, then closes as `STALE` (see
  [Cancelling an offer](#cancelling-an-offer-xrpl-042)). Either way, the ledger no longer lets anyone accept
  it once the NFT has moved.

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
- **Resale purchase (XRPL-039):** `tests/testnet/resale-purchase.testnet.test.ts`, on a one-ticket event.
  - The primary sale
    ([`01446412…FFEB3923`](https://testnet.xrpl.org/transactions/014464126B08829FC3EC2828A097BD68C08F10E02DDF67B0E854F06BFFEB3923))
    sold the event out, which opened in-app resale.
  - The holder listed the ticket for 1.5 XRP
    ([`E839D814…4D0FB6B0`](https://testnet.xrpl.org/transactions/E839D814D8FC63BDB943DF75FA2979F569107C35934DDE14ADC4808F4D0FB6B0)).
    The resale rule listed it, and the offer page showed it for sale to another fan.
  - That fan bought it in their own wallet
    ([`C7D1563D…832F6B29`](https://testnet.xrpl.org/transactions/C7D1563D69B024D99676A4E7CAA4659315B1763CC0839CE37BFE7F3F832F6B29),
    `tesSUCCESS`, ledger 22489127). On the ledger the NFT moved to the fan, the offer was gone, and the
    holder's balance rose by exactly 1.5 XRP.
  - In the app, My tickets (read from each wallet's NFTs) showed the ticket for the fan and not for the
    previous holder. The offer was `ACCEPTED`, the listing was gone, and the organiser's figures counted
    one resale.
  - The fan then checked in once. A second scan, and a door code for the previous holder, were refused.

## Cancelling an offer (XRPL-042)

The wallet that made a sell offer withdraws it with an `NFTokenCancelOffer` signed in its own Xaman
wallet. That covers a holder's resale listing, private sale or gift, and an organiser's primary listing.
Code: `src/lib/xrpl/offers/cancel.ts`. On screen: **Cancel this offer** on the ticket page.

1. **Request.** `POST /api/offers/:id/cancel-intent` with `{}` and an `Idempotency-Key` header.
   - 201 `{ data: { offer, request } }`. The offer is still `ACTIVE`, and `request` is what the owner approves in
     Xaman (purpose `CANCEL_OFFER`, `NFTokenOffers: [offerIndex]`, a memo `xrpl-ticketing/cancel` holding the
     offer ID).
   - 403 `WALLET_NOT_VERIFIED`.
   - 404: an unknown offer, or one this wallet didn't make, so private sales and gifts stay private.
   - 409: the offer is still awaiting its own approval, is no longer open, or a cancellation is already
     waiting in Xaman. Also 409 when the offer is already gone from the ledger: it's then closed as `STALE`
     and nothing is signed.
2. **Recording.** `GET /api/offers/:id` settles the cancellation, along with creation and purchases.

| Outcome | Offer state | `LedgerTransaction` |
|---|---|---|
| Validated `tesSUCCESS`, signed by the offer's owner, and the offer is gone from the ledger | `CANCELLED`, with `cancelTxHash` | `VALIDATED_SUCCESS` |
| Validated, but the ledger still shows the offer | stays `ACTIVE` | `VALIDATED_SUCCESS` |
| Declined, expired or never validated | stays `ACTIVE` | `DROPPED` |
| Refused by the ledger (`tec`) | stays `ACTIVE` if the ledger still backs it, otherwise `STALE` | `VALIDATED_FAILURE` |

Until the cancellation validates, someone can still accept the offer, and the ledger settles whichever comes
first. An offer recorded `ACCEPTED` stays accepted. Once cancelled, the ticket can be offered again.

**Stale-offer cleanup.** Before the ticket page or an offer page shows an open offer, the app settles what's
in flight and re-checks the ledger (`syncOfferWithLedger` in `ledger-check.ts`):
- An offer past its `expiresAt` becomes `EXPIRED`.
- One that is gone or no longer matches becomes `STALE`. That covers an offer taken or cancelled outside the
  app, or one whose seller no longer holds the NFT.
- While a purchase or cancellation of it is in flight, it's left alone.

Closed offers leave every active view: the ticket page, the offer page, `/resale` and the event page. Buying
re-checks the ledger too. If the ledger can't be reached, the screens show the offer as last recorded.

**Limitations:**
- There's no background sweep. An offer closed outside the app stays listed on `/resale` until someone
  opens it or tries to buy it.
- Primary listings can be cancelled through the API only. The organiser screens don't show a cancel button
  yet.

Verified on XRPL Testnet (21 Nov 2026) by the live lifecycle suite. The buyer listed the ticket for resale
[`B0D31042…74DC03BF`](https://testnet.xrpl.org/transactions/B0D310423A5FD0A5390152ADCDFED90CE1ACFFC9A0EF285C890E532974DC03BF)
and cancelled it
[`72C0A342…4CB40F83`](https://testnet.xrpl.org/transactions/72C0A342AB17DF5418A8DF51302E2AB0294B2EDE407B84C3B1EF4B950CB40F83)
(`NFTokenCancelOffer`, `tesSUCCESS`). The app recorded `CANCELLED` only from that validated transaction, the
offer was gone from the ledger, and the buyer still held the ticket.
