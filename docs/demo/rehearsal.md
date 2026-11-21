# Live Testnet rehearsal of the demo story (XRPL-052)

The hackathon story, end to end on live XRPL Testnet: a seller mints a ticket, a buyer buys it, the
buyer resells it, a new wallet buys it and gets in at the door, once.

There are two ways to run it. The **scripted rehearsal** runs the whole story through the app's own
services in about 90 seconds, with throwaway wallets approving in Xaman's place. The **on-phone
rehearsal** is the same story clicked through the real screens with the Xaman app, and is what the judges
see ([demo-script.md](demo-script.md)).

## Scripted rehearsal

```bash
npm run db:up
npm run test:testnet -- tests/testnet/resale-purchase.testnet.test.ts
```

It needs the internet (the public Testnet and its faucet). Every step waits for a validated ledger
result, never for a fixed time.

| Story step | What the run checks |
|---|---|
| Seller creates an event and mints a ticket | A one-ticket event. The ticket is `MINTED` only from the validated `NFTokenMint`, and the ledger shows the seller's wallet holding the NFT |
| Buyer purchases it and views it | The seller lists it, the buyer accepts in their own wallet, and the ledger shows the buyer holding it. The event is now sold out, which opens in-app resale |
| Buyer resells it | The buyer lists it for 1.5 XRP. The ledger holds the sell offer, the resale rule lists it publicly, and the offer page offers it to another fan |
| A new wallet accepts and gains ownership | Another fan buys it in their own wallet. The ledger moves the NFT to them and pays the buyer exactly 1.5 XRP. My tickets shows it for the fan and no longer for the buyer |
| The new owner checks in | The fan gets a door code, proves control of the wallet with a signed sign-in, and is admitted |
| A duplicate check-in is rejected | A second scan of the same code answers `ALREADY_USED`, the previous holder can't get a door code, and there is exactly one attendance record |

### Run of 21 Nov 2026

All six steps passed (71 seconds). Every transaction is validated `tesSUCCESS` on Testnet:

| Step | Transaction | Ledger |
|---|---|---|
| Mint | [`4089175C…F0428918`](https://testnet.xrpl.org/transactions/4089175CBCC0F7AB872362B3BD74A6AED78EFF5EA00023A1C4AB37B3F0428918) | 22489117 |
| Primary offer | [`B7ACD4B7…1E77C889`](https://testnet.xrpl.org/transactions/B7ACD4B750FA674064A3CFCC1EDE9BB48D81FF62DC6385B8AB840B8D1E77C889) | 22489119 |
| Primary purchase | [`01446412…FFEB3923`](https://testnet.xrpl.org/transactions/014464126B08829FC3EC2828A097BD68C08F10E02DDF67B0E854F06BFFEB3923) | 22489122 |
| Resale listing | [`E839D814…4D0FB6B0`](https://testnet.xrpl.org/transactions/E839D814D8FC63BDB943DF75FA2979F569107C35934DDE14ADC4808F4D0FB6B0) | 22489124 |
| Resale purchase | [`C7D1563D…832F6B29`](https://testnet.xrpl.org/transactions/C7D1563D69B024D99676A4E7CAA4659315B1763CC0839CE37BFE7F3F832F6B29) | 22489127 |

The ticket NFT,
[`00080000B4FF…01572817`](https://testnet.xrpl.org/nft/00080000B4FFFA0C70EE0AEDA20883906DB737C4A7FF7F47D3814AA701572817),
ended in the resale buyer's wallet. The check-in itself is not a ledger transaction: it reads the owner
from a validated ledger and records the admission in the app's database.

The same story with a private sale and a gift instead of a public resale, plus a cancelled listing, runs
in `tests/testnet/ticket-lifecycle.testnet.test.ts`.

### What is real and what is stood in for

| Part | In the scripted rehearsal |
|---|---|
| The app's services, database, rules and ledger reads | Real |
| XRPL Testnet transactions | Real: built by the server, validated by the ledger |
| The wallets | Real Testnet accounts from the faucet, created for the run and thrown away. No seed is saved or printed |
| Approving in the Xaman app | **Stood in for.** A test double signs exactly the transaction the server built with the throwaway wallet, as Xaman would |
| The wallet sign-in at login | **Stood in for.** Sessions start with the wallet as proven. The check-in sign-in is real: signed with the wallet's key and verified by the app |
| The screens | Not exercised. The run calls the services the screens call |

## On-phone rehearsal

Do this once before the demo, on the deployment and phones that will be used, following
[demo-script.md](demo-script.md). It covers what the scripted run can't: the real Xaman approvals, the
screens, the QR codes, and the venue's network.

Checklist to tick off:

- [ ] Each phone's Xaman is on **Testnet**, and each demo wallet has at least 10 XRP.
- [ ] Seller: sign in, connect the wallet, create and publish an event with a one-ticket tier, mint the
      ticket, and list it. Each approval opens in Xaman and is confirmed with an explorer link.
- [ ] Buyer: connect the wallet, buy the ticket, and see it in **My tickets** with its explorer link.
- [ ] Buyer: list the ticket for resale. It appears under **Resale tickets** because the event is sold out.
- [ ] New owner: connect a third wallet, buy the resale ticket, and see it in **My tickets**. It has left
      the buyer's.
- [ ] New owner: open the ticket, show the check-in code, and approve it in Xaman.
- [ ] Organiser (the seller's account): scan the code, see **Valid ticket**, and admit.
- [ ] Organiser: scan the same code again and see **Already checked in**.
- [ ] Note each transaction hash from the explorer links, to show if the network is slow on the day.
- [ ] Confirm one mint in the explorer carries the `LastLedgerSequence` the app set (XRPL-027).

If a step fails on the day, the fallbacks are in [demo-script.md](demo-script.md#if-something-fails).
