# Resale guardrails: what the app can and can't control (XRPL-095)

Ticket NFTs are **transferable**, so holders can resell or gift them. That also means **no rule in this app
can fully stop scalping.** This page says which guardrails the app applies, which are optional, and where
they stop working.

## What XRPL itself enforces

| Lever | Set when | Effect | Limits |
|---|---|---|---|
| `tfTransferable` flag | Mint | Without it, only the issuer can trade the NFT | Off means **no resale or gifting at all**, which we need. We keep it on. |
| `TransferFee` (0–50%) | Mint | Issuer earns a cut of each NFT-for-token sale | A royalty, **not a price cap**. Easy to avoid with a 0-XRP sale plus off-ledger payment. Explored in XRPL-094. |
| Offer `Destination` | Each offer | Only the named account can accept | Used for private sales and gifts. Doesn't limit price. |
| `tfBurnable` flag | Mint | Issuer can burn the NFT | Could cancel tickets, but means the issuer can take a ticket away. Not used. |

**There is no on-ledger price ceiling for NFT sales.** Any price limit is a platform rule.

## Guardrails in this app

| Guardrail | Status | Where |
|---|---|---|
| Public resale only after primary sells out | **On** | `ResalePolicy.getEligibility` (XRPL-037) |
| Resale closes when the event ends | **On** | `ResalePolicy.getEligibility` |
| Only live `RESALE` offers listed; private and gift offers never public | **On** | `ResalePolicy.listPublicOffers` |
| Direct API lookups can't reach hidden listings | **On** | `ResalePolicy.getPublicOffer`, which Agent B's buy route must call |
| Check-in needs the current holder's wallet to approve | **On** | Check-in (XRPL-045). Stops selling one ticket as screenshots to many people. |
| **Price cap: face value + N%** | **Optional, off by default** | `new ResalePolicy({ guardrails: { maxMarkupPercent: N } })` |

### The optional price cap

- **Effect:** listings priced above `faceValue × (100 + N) / 100` (integer drops, rounded down) are
  hidden from the app's resale list and can't be fetched or bought through the app.
- **Check before listing:** `checkResalePrice(faceValueDrops, amountDrops)` returns `{ allowed, maxDrops }`,
  so the "list my ticket" flow (XRPL-036) can tell the seller **before** they create an offer on XRPL
  that the app would hide.
- **UI notice:** `priceCapNotice()` returns the text to show, or `null` when the cap is off.
- **Why off by default:** the issue asks to keep guardrails optional until tested and reviewed. To turn it
  on, pass `maxMarkupPercent` where Agent A/B construct the policy. Suggested demo value: `10`.

## Seller verification ideas (not built)

- **Listing limits:** at most N live resale listings per account per event.
- **Verified wallet:** require the session's verified wallet (XRPL-012) to list, so one account can't
  list from many anonymous wallets.
- **Cooling-off:** no resale listing within X hours of buying, to slow buy-to-flip bots.
- **Organiser-set caps:** per-event `maxMarkupPercent` chosen by the organiser.
- **Face-value exchange:** the organiser buys back at face value and relists. This needs organiser
  funds and custody rules.
- **Pattern flags:** flag accounts that buy many tickets across events and relist them quickly. Review
  manually rather than block automatically.

## Loopholes we expect

| Loophole | Why the app can't stop it | Mitigation |
|---|---|---|
| Sell on another NFT marketplace | The NFT is transferable; other platforms ignore our rules | Check-in reads the **current** owner, so the buyer still gets in. Say plainly that the app's rules are app-only. |
| Wallet-to-wallet transfer plus off-ledger payment | A 0-XRP or `Destination` offer looks like a gift on-chain | None on-chain. Listing limits and pattern flags help a little. |
| List at face value, take the rest as a side payment | The app only sees the listed price | Price caps can't catch it. Verified sellers raise the effort needed. |
| Many wallets or accounts per person | Wallets are free to create | Verified wallets per account and per-account limits |
| Bots buying primary stock | Primary sale is first-come | Out of scope for the hackathon. Purchase limits per account would help. |
| Selling screenshots of a QR to several people | — | **Already blocked.** The code expires, needs the holder's wallet approval, and admits once. |

## Wording rules for the UI

- Say "in this app", never "on the blockchain", for any resale restriction.
- Always show `RESALE_LIMITATION_NOTICE` where resale is offered, and `priceCapNotice()` when the cap is on.
- Never say the platform "prevents scalping". Say it "limits resale inside the app".
