# NFT transfer fees (Agent B, XRPL-094)

An investigation, not a feature: **the app mints tickets with no transfer fee today**
(`TICKET_NFT_FLAGS` in `src/lib/xrpl/tickets/metadata.ts`). This page records what the ledger's
transfer fee does, what it would take to offer it to organisers, and what it must not be sold as.

## What a transfer fee is

An issuer can set a `TransferFee` when minting an NFT (`NFTokenMint`). It is a royalty: a share of every
later sale that the ledger pays to the issuer automatically.

| Property | Value |
|---|---|
| Units | 1/100,000 of the sale amount: `5000` is 5% |
| Range | 0 to 50,000 (0% to 50%) |
| Requires | the `tfTransferable` flag. The ledger refuses a fee on a non-transferable NFT |
| Stored in | the NFTokenID itself (`parseNFTokenID(id).TransferFee`), so anyone can read it and nobody can change it |
| Paid to | the issuer's account, in the currency of the sale |
| Paid by | the seller: it comes out of what they receive. The buyer pays the price they agreed |

## When it applies

Checked on Testnet with dedicated fixtures (`tests/testnet/transfer-fee.testnet.test.ts`, below), for an
NFT minted with a 5% fee:

| Transfer | Fee charged | What happened |
|---|---|---|
| The issuer's own sale (the primary sale) | none | The issuer received the full 1 XRP |
| A resale between two other wallets at 2 XRP | 5% | The issuer received 0.1 XRP, the seller 1.9 XRP, and the buyer paid 2 XRP plus the network fee |
| A free transfer (a zero-price offer to a named wallet) | none | The NFT moved and the issuer received nothing |
| Minting with a fee but without `tfTransferable` | n/a | The transaction is refused |

Not tested here, from the XRPL documentation:

- A sale where the issuer is the buyer also pays no fee.
- Brokered sales (a third account matching a buy and a sell offer) pay the fee as well.
- For a sale in an issued currency rather than XRP, the issuer must already hold a trust line for that
  currency, or the offer can't be made. The app only sells in XRP, so this doesn't arise.

## What it does not do

**A transfer fee does not prevent scalping, in or outside the app, and must not be described as if it
did.**

- It is a percentage of the price *recorded on the ledger*. A seller and buyer who settle the real price
  somewhere else can move the ticket with a zero-price offer and pay nothing, as the free transfer above
  shows.
- It doesn't limit the price. A ticket can still be resold on the ledger at any price; the issuer just
  receives a share.
- It can't be added or raised later, so it can't react to how a sale is going.

What it does give an organiser is a share of resales that happen at a declared price, including ones
made with other wallet apps. The app's own protections are separate and in-app only: resale opens only
after the primary sale sells out (XRPL-037), and the optional price cap (XRPL-095).

## What offering it would take

The fee is fixed at mint, so it has to be an organiser's choice before any ticket of an event exists.

| Area | Change needed |
|---|---|
| Data (Agent A) | A fee per event or tier (0 to 50,000), locked once the first ticket is minted, like price and supply |
| Minting (`requestTicketMint`) | Add `TransferFee` to the `NFTokenMint` the server builds |
| Recording (`applyConfirmedMint`, the ledger check) | Verify the minted NFTokenID carries the configured fee, as issuer and taxon are verified now |
| Selling screens | Show a holder what they will receive after the fee before they list, and say who gets the rest |
| Organiser figures | Royalty income isn't recorded anywhere today. It would be read from each validated sale's balance changes |
| Existing tickets | Unaffected, and they can never gain a fee |

Compatibility with what is built:

- **Purchases** are unchanged: the buyer still pays the offer amount, so the wallet readiness check and
  the purchase flow need nothing.
- **Gifts and private sales at zero price** pay no fee.
- **The primary sale** pays no fee, because the organiser's wallet is the issuer and the seller.
- **Reserves** are unchanged: a fee adds no ledger objects.
- **The resale rule and the price cap** don't interact with it.

## Verified on XRPL Testnet

`npm run test:testnet -- tests/testnet/transfer-fee.testnet.test.ts`, with three throwaway faucet
wallets. Balances were read from validated ledgers before and after each accept, so the figures in the
table above are the ledger's own. From the run of 21 Nov 2026:

| Step | Transaction |
|---|---|
| Mint with `TransferFee: 5000` | [`DEC8A095…BCE96EDE`](https://testnet.xrpl.org/transactions/DEC8A09513D3259838803B85C39E4C7831FA8364218A4400775C5DEBBCE96EDE) |
| Primary sale, 1 XRP: no fee | [`61AAADA1…7410A16D`](https://testnet.xrpl.org/transactions/61AAADA1AB8DB5DE315D95AAADD7B3AB86F71E177C3F71BF99A550B47410A16D) |
| Resale, 2 XRP: 0.1 XRP to the issuer | [`E7D2DFD3…D3F74577`](https://testnet.xrpl.org/transactions/E7D2DFD3B18BB52F1F0A9725EE874EC4E94A98F8CC32BF69F2B6B1ADD3F74577) |
| Free transfer: no fee | [`2339986D…83B8BB2B`](https://testnet.xrpl.org/transactions/2339986DA8E825E1D21DEBC2D6A5826ABEE928492BE5E94190A2C56E83B8BB2B) |

NFT: [`000813884148…015728F5`](https://testnet.xrpl.org/nft/000813884148ED1BD1B3EFE40E17894C089BE7BB2DD7932EDAF037CE015728F5). Its ID carries the fee: the `1388` after the `0008` flags is 5000 in hexadecimal.

## Limitations of this investigation

- XRP only. Issued-currency sales and brokered sales were not exercised.
- Nothing in the app sets, shows or accounts for a transfer fee yet. Everything under "What offering it
  would take" is a proposal.
