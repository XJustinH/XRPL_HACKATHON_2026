# Judge demo: script, data and fallbacks (XRPL-054)

About six minutes. One story: a ticket is minted, sold, resold, and used once at the door, with every
step provable on the XRP Ledger Testnet explorer.

Nothing here runs on Mainnet and no real money moves. Say so at the start.

## The day before

1. **Deployment.** Deploy `main` and run `npm run db:deploy`, then `npm run db:seed`
   ([seed-data.md](../seed-data.md)). Set:
   - `DEMO_LOGIN_ENABLED=true`, so the seeded demo accounts can sign in;
   - `XAMAN_API_KEY` and `XAMAN_API_SECRET`;
   - `APP_BASE_URL` and `TICKET_METADATA_BASE_URL` to the public https address, so Xaman and the explorer
     can show each ticket's details.
2. **Network.** `npm run xrpl:check-network` reports every node OK.
3. **Wallets.** Prepare the three demo wallets below.
4. **Rehearse.** Run the story once on the phones and the deployment that will be used
   ([rehearsal.md](rehearsal.md#on-phone-rehearsal)), and keep the explorer links it produces. That run
   also leaves the sample tickets used as fallbacks: a sold-out event with a ticket that has changed
   hands, and a ticket that is already checked in.

### Demo wallets

Three Testnet accounts: **seller**, **buyer** and **new owner**.

```bash
npm run xrpl:dev-wallet -- demo-seller
npm run xrpl:dev-wallet -- demo-buyer
npm run xrpl:dev-wallet -- demo-new-owner
npm run xrpl:dev-wallet -- --list      # addresses only
```

- Each is created and funded by the Testnet faucet, so they are pre-funded.
- Their seeds are written only to `.xrpl-dev-wallets.local.json` on that laptop. The file is git-ignored
  and the tool refuses to write it otherwise. **That file is the recovery copy.** Keep it on the
  presenter's laptop, and never open it on a shared screen, paste it in chat, or commit it.
- Import each account into Xaman on a demo phone (**Add account → Import an existing account → Family
  seed**), and switch Xaman to **Testnet**. From then on the app only ever sees public addresses and
  signed approvals.
- A wallet needs about 10 XRP for the whole story. Top one up by sending it Testnet XRP from another dev
  wallet.
- The Testnet is reset from time to time, which deletes every account. If a wallet has gone, create new
  ones the same way.

### Accounts in the app

Sign in at `/onboarding` with the seeded demo accounts, then connect a wallet at `/connect`. A demo
account must prove its wallet again in each session.

| Person | Demo account | Wallet |
|---|---|---|
| Seller, and organiser at the door | `The Testnet Tones` | demo-seller |
| Buyer | `Alex Fan` | demo-buyer |
| New owner | `Sam Friend` | demo-new-owner |

## The script

Each step lists who acts, where, and the proof to point at. Lines in quotes are what to say.

| # | Who | Do | Show |
|---|---|---|---|
| 1 | Seller | **Manage events → New event.** Create "Demo night" with one ticket type: 1 ticket at 1 XRP. **Publish event** | It appears on the home page under **Discover events** |
| 2 | Seller | On the event's page, under **Mint tickets**, press **Mint next ticket** and approve in Xaman | The ticket turns **Minted** with links to the NFT and the mint transaction. Open the transaction: validated, `tesSUCCESS` |
| 3 | Seller | Press **List 1 for sale at 1 XRP** and approve | The ticket shows **For sale · 1 XRP** |
| 4 | Buyer | Open the event, **Buy ticket**, then **Buy for 1 XRP**, and approve in Xaman | "You own ticket #1. It's in your wallet as an NFT." Open **Purchase transaction**: the NFT and the XRP swapped in one ledger transaction |
| 5 | Buyer | **My tickets** | The ticket is listed, read from the wallet's NFTs on the ledger |
| 6 | Buyer | Open the ticket, choose **Sell**, enter 1.5 XRP, **List for sale**, approve | **Resale tickets** now lists it, because the event has sold out |
| 7 | New owner | **Resale tickets**, open the listing, **Buy for 1.5 XRP**, approve | "The ticket is now in your wallet." It has left the buyer's **My tickets** |
| 8 | New owner | Open the ticket, show the check-in code, approve in Xaman | A QR code with a countdown: **Ready: show this at the door** |
| 9 | Organiser | **Check-in** for the event: scan the code | Green **Valid ticket**, read live from the ledger. Press **Admit** |
| 10 | Organiser | Scan the same code again | Red **Already checked in**. The entry count went up by one, not two |

What to say along the way:

- Step 2: "The app never holds a key. The seller's own wallet signs, and the ticket only counts as minted
  once the ledger has validated it."
- Step 4: "There is no payment processor. The ledger moves the ticket and the XRP together, or neither."
- Step 6: "Resale opens in this app only once the primary sale has sold out. That rule is ours, in the
  app. A transferable NFT can always be moved on the ledger with another wallet, and we say so."
- Step 9: "A screenshot isn't enough. The wallet that holds the ticket has to approve this exact code,
  and the door reads the owner from the ledger at that moment."

If there is time: the organiser's **Analytics** and **Inventory** pages show the sale, the resale and
the entry; a seller can **Check against the ledger** to compare every ticket with its mint.

## What is confirmed, simulated or deferred

Say which is which. Don't present anything in the last two rows as live.

| | What | How to tell |
|---|---|---|
| **Confirmed on Testnet** | Minting, primary sale, resale, private sale, gift, cancelling an offer | Each has a validated transaction on [testnet.xrpl.org](https://testnet.xrpl.org), linked from the app |
| **Confirmed on Testnet** | Ownership at the door and in My tickets | Read from a validated ledger at that moment |
| **Real, in the app's database** | Events, accounts, the check-in record, analytics, the resale rule | Not ledger transactions. One admission per ticket is enforced by the database |
| **Simulated** | The demo accounts and seeded events | Fictional venues marked `(demo venue)`, and every event description opens with a notice |
| **Simulated** | Payment for physical merchandise | The checkout says the payment is simulated. No card details are taken |
| **Needs setup** | Spotify listening status | Works only where a Spotify app's credentials are configured |
| **Not built** | Mainnet, real-money payments, transfer-fee royalties ([transfer-fees.md](../xrpl/transfer-fees.md)) | `XRPL_NETWORK` accepts only `testnet` or `devnet` |

Limits to state honestly:

- The sold-out resale rule is **app-side**. It controls what this app lists, not what the ledger allows.
- Buying a ticket or collectible NFT doesn't transfer copyright in any artwork or media.
- A ticket moved outside the app shows correctly in the app once it is checked against the ledger.

## If something fails

| Problem | Do this |
|---|---|
| Xaman doesn't open or approve | Check the phone is on **Testnet** and online. Start the step again: nothing was sent, and the app says so |
| The ledger is slow to validate | Keep talking. The screen moves on by itself, and never shows success early |
| A wallet has too little XRP | The app says how much is spare before asking. Top it up from another demo wallet |
| The venue network blocks the phones | Use the sample tickets from the rehearsal: show the sold-out event, the ticket in the new owner's **My tickets**, and the explorer links noted then |
| No phone works at all | Run the scripted rehearsal on the laptop. It performs the same story on live Testnet in about 90 seconds: `npm run test:testnet -- tests/testnet/resale-purchase.testnet.test.ts`. Then open its transactions in the explorer ([rehearsal.md](rehearsal.md#run-of-21-nov-2026)) |
| The door step can't run live | [checkin-rejections.md](checkin-rejections.md#fallback-no-live-wallet-approval) has the same cases as an automated run |

## Explorer proofs to keep open in tabs

From the rehearsal run of 21 Nov 2026 ([rehearsal.md](rehearsal.md)). Replace them with the links from
your own on-phone rehearsal once you have them.

- Mint: <https://testnet.xrpl.org/transactions/4089175CBCC0F7AB872362B3BD74A6AED78EFF5EA00023A1C4AB37B3F0428918>
- Primary purchase: <https://testnet.xrpl.org/transactions/014464126B08829FC3EC2828A097BD68C08F10E02DDF67B0E854F06BFFEB3923>
- Resale purchase: <https://testnet.xrpl.org/transactions/C7D1563D69B024D99676A4E7CAA4659315B1763CC0839CE37BFE7F3F832F6B29>
- The ticket NFT: <https://testnet.xrpl.org/nft/00080000B4FFFA0C70EE0AEDA20883906DB737C4A7FF7F47D3814AA701572817>
