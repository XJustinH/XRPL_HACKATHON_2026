# src/lib/ownership — Agent A

Keeps ticket ownership in step with the XRP Ledger. It records the app's accepted offers from their
validated transactions (XRPL-032), and syncs ownership after a resale, a gift or a transfer outside the app
(XRPL-043). The ledger is the source of truth: nothing here records anything a validated ledger hasn't proven.

| File | What |
|---|---|
| `transfers.ts` | `reconcileLedgerTransaction(deps, hash)` records one of the app's offers, accepted in the app or from another wallet |
| `ticket-sync.ts` | `reconcileTicket(deps, { ticketId })` brings a ticket's live offers and its owner in step with the ledger |
| `history.ts` | `getTicketHistory(deps, ticketId, current)` builds a ticket's transfer history. `buildTicketHistory` is the pure part |

| Route | Who | Returns |
|---|---|---|
| `POST /api/ledger/transactions/:hash/reconcile` | signed in | `LedgerReconcileResult` |
| `POST /api/tickets/:id/reconcile` | signed in | `TicketReconcileResult` |
| `GET /api/tickets/:id/history` | anyone, like the ticket's ownership | `TicketHistory` |

The types are in `src/contracts/ownership.ts`. The ticket page (`/tickets/:id`) shows the history and a
**Check the ledger again** button (`src/features/ownership`). Production wiring for these functions is
`mintingDeps()` from `@/lib/xrpl/tickets/server`.

## Recording an accepted offer from its hash

`reconcileLedgerTransaction` applies one **validated** `NFTokenAcceptOffer` that took one of the app's sell
offers. It finds the offer from the transaction's `NFTokenSellOffer` (`acceptedSellOfferIndex` in Agent B's
ledger reader).

| Offer | Recorded as | Ticket |
|---|---|---|
| `PRIMARY` | `PRIMARY_SALE` | `primarySoldAt` (the ledger close time) and `primarySaleTxHash`, plus the new owner |
| `RESALE`, `PRIVATE`, `GIFT` | `RESALE`, `PRIVATE_SALE`, `GIFT` | the new owner only: the primary sale stays as it was |

- **The offer** becomes `ACCEPTED`, with `acceptTxHash` and `acceptedByAddress`, the account that accepted it.
- **The cached owner** becomes the accepting account once the ledger confirms that account holds the NFT. If
  the cache already came from a later ledger, it is left alone. That happens when a hash is reported after
  the ticket moved on.
- **Exactly once.** The transaction is claimed in `LedgerTransaction` (unique `hash`, `appliedAt`).
  - If the in-app purchase attempt (Agent B's purchase flow) is still waiting for its hash, reconciliation
    uses that row. The in-app flow then sees the transfer as already applied.
  - Repeated or concurrent calls return `ALREADY_APPLIED` and change nothing.
- **Refused:**
  - A transaction that isn't validated yet gives `LEDGER_TX_NOT_VALIDATED` (409, retry later), and nothing
    is recorded.
  - An accept that moved a different NFT than the offer's, or a private sale or gift taken by someone
    other than its recipient, gives 409. The ledger wouldn't allow either.
- **Ignored:** other transaction types, and accepts that took no offer of the app's, return `NOT_APPLICABLE`.
- **Brokered sales:** the accepting account is the broker, so the ticket's owner is left `STALE` rather
  than guessed.

## Bringing a ticket in step with the ledger

`reconcileTicket` is the refresh path for a ticket that may have moved.

1. **Each live offer is brought up to date** (awaiting approval or active), using Agent B's offer services:
   - its creation,
   - any purchase or cancellation in flight,
   - then the ledger itself (the stale-offer check from XRPL-042).

   An offer the ledger no longer backs closes (`STALE` or `EXPIRED`). That includes an offer whose owner
   has since transferred the ticket away: nobody can buy it any more, so it leaves every listing.
2. **The owner is read from a validated ledger,** and the app's cache is refreshed (Agent B's
   `resolveTicketOwnership`). The result says whether the owner changed.

**A previous holder can't act on a ticket they've given away.** Every action reads ownership from a
validated ledger, never from the app's cache:
- listing or offering it (Agent B's primary and holder offers);
- `requireTicketOwner`;
- check-in at the door (Agent D).

Reconciling also closes their old listings. The tests show both.

## Transfer history

`getTicketHistory` builds the history from what the app recorded from validated transactions: the mint,
then each of the app's offers that was accepted, in ledger order. Each step says who held the ticket before
and after. These steps are `source: "PLATFORM"`, with their transaction and its explorer link.

Wherever that chain doesn't join up, the ticket moved outside the app. Those moves become `OUTSIDE_APP`
entries with `source: "EXTERNAL"`:
- **Between two recorded steps:** a later offer came from someone other than the last known holder. The
  move is dated by the ledger in which that offer was validated.
- **After the last step:** the holder on a validated ledger now isn't the last known holder. The move is
  dated by the ledger that was read.

The app saw only the result of such a move. It can't say how or when it happened, at what price, or how many
wallets the ticket passed through, so the entry has no transaction. Nothing is stored for these entries:
the history is rebuilt from the records and the verified holder each time it's read. If the holder can't
be read, `ownerVerified` is false and the history ends at the last recorded step. An NFT destroyed outside
the app ends with `BURNED`.

## Limitations

- **Nothing runs on a schedule.** Ownership is refreshed when:
  - someone opens the ticket page, or uses **Check the ledger again**;
  - a hash is reported;
  - a listing or purchase screen checks an offer.

  An unreported sale of the app's offer made outside the app first shows as a move outside the app, and
  its offer is closed as `STALE`. Once its hash is reported, it's recorded as the sale it was.
- **An unsold ticket can leave the seller's wallet outside the app.** It still counts as unsold in primary
  inventory, because the app can't tell a sale from a move between the seller's own wallets. Its history
  shows the move, and its listing is closed.
- **In a brokered sale, the history shows the broker as the recipient.** The step after it, to the real
  buyer, shows as a move outside the app.

## Verified on XRPL Testnet (21 Nov 2026)

**`tests/testnet/primary-sale-reconcile.testnet.test.ts` (XRPL-032).** A buyer wallet accepted the app's
primary sell offer straight on the ledger, bypassing the app:
[`95D96B48…DC19A296`](https://testnet.xrpl.org/transactions/95D96B48878A26B386C7018D47B20E64D5BFAC807AC0B45EB42A1303DC19A296)
(`tesSUCCESS`, ledger 22485392). From the hash alone:
- the offer became `ACCEPTED`;
- the ticket was marked sold at the ledger close time, with the buyer as its owner;
- the event showed as sold out.

Reporting the hash again, twice at once, changed nothing.

**`tests/testnet/ownership-sync.testnet.test.ts` (XRPL-043),** on ticket NFT
[`00080000…01571FFF`](https://testnet.xrpl.org/nft/00080000AA2F3E9906F44221C96205C7EF51E87C7B7EC5F0F5ADBB1D01571FFF),
whose explorer page also lists the transfers made outside the app:

1. **A gift accepted outside the app.** The buyer offered the ticket to a friend as a gift through the app.
   The friend accepted it from their own wallet:
   [`D4CD592B…54B3C779`](https://testnet.xrpl.org/transactions/D4CD592B005C00C901383813EC288BE894EEB17EDB8A39885A2E074854B3C779)
   (ledger 22487056). The app recorded the `GIFT` from the hash alone. The buyer could no longer offer the
   ticket.
2. **A hand-over outside the app.** The friend listed the ticket for resale through the app
   ([`4BB3C42D…61765E66`](https://testnet.xrpl.org/transactions/4BB3C42DBEA9413012095686D2B9968F79ACCCD7451B3BD4ACA7E28561765E66)),
   then handed it to a fourth wallet entirely outside the app. `reconcileTicket` found the new owner and
   closed the friend's listing as `STALE`, and the friend could no longer offer the ticket.
3. **The history** read: Minted, Sold by the organiser and Gifted, all recorded with validated transactions,
   then a move outside the app from the friend to the fourth wallet.
