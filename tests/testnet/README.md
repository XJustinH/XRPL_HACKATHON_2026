# Live Testnet lifecycle test (XRPL-050)

Runs the ticket lifecycle against the real XRPL Testnet, so we know the app works with the actual ledger,
not just with fakes.

```bash
npm run db:up          # Postgres, if it isn't running
npm run test:testnet   # about four minutes; needs the internet
```

To run it without a local setup, use GitHub: **Actions → Testnet lifecycle → Run workflow**
(`.github/workflows/testnet.yml`).

It is **not part of CI or `npm test`**: it depends on the public Testnet and its faucet, which can be slow
or down. Run it before merging ledger changes and before the demo rehearsal. It uses the same `*_test`
database as `npm run test:db` and wipes it, so don't run the two at the same time.

## What it checks

| Step | Status |
|---|---|
| Mint a ticket NFT. The ticket becomes `MINTED` only from the validated ledger result, and is recorded exactly once | Runs |
| Look up the NFT on the ledger: the seller's wallet holds it, and it is transferable with the ticket's metadata URI | Runs |
| List the ticket for sale at its tier price. The offer becomes `ACTIVE` only once validated, the ledger shows the same open sell offer (seller, price, no destination), and it appears in the event's public listing | Runs |
| A buyer accepts the offer with their own wallet. Recorded as sold, with the buyer as owner, only from the validated ledger result. On the ledger the buyer holds the NFT, the seller doesn't, and the offer is gone. The ticket leaves the public listing | Runs |
| A sale made **outside the app** (`primary-sale-reconcile.testnet.test.ts`, XRPL-032). The buyer accepts the listed offer straight on the ledger with their own wallet, and only the transaction hash reaches the app. The offer is recorded as accepted and the ticket as sold at the ledger close time, with the buyer as owner, and the event is sold out. Reporting the same hash again, even twice at once, changes nothing | Runs |
| Ownership kept in step after moves **outside the app** (`ownership-sync.testnet.test.ts`, XRPL-043). A gift made in the app and accepted from the recipient's own wallet is recorded from its hash alone, and the giver can no longer offer the ticket. The holder then lists it in the app and hands it to another wallet outside the app. Reconciling the ticket finds the new owner and closes the old listing, and the old holder can no longer act on it. The ticket's history shows the recorded steps, each with its validated transaction, then the move outside the app | Runs |
| The buyer sells privately to a friend, and the friend gives it back as a gift. Each offer names its recipient (`Destination`). Another wallet is refused by the app, and by the ledger itself when it tries directly. Ownership moves only from validated results | Runs |
| The holder lists the ticket for resale, then cancels it (`NFTokenCancelOffer`, XRPL-042). The offer stays open until the cancellation validates, then is recorded `CANCELLED` with its hash. The ledger no longer shows it, and the holder still holds the ticket | Runs |
| The holder checks in once, and a second check-in is rejected. The seller (no longer the owner) can't get a door code; an unapproved code is refused; another wallet can't approve the holder's code; the holder approves with a Xaman-style sign-in signed by their own Testnet key, which the app verifies; ownership is read from a validated ledger at the door; a repeat scan and a fresh code for the used ticket are refused; exactly one attendance record | Runs |
| The organiser's figures match the real sale and entry: inventory (1 of 2 sold), analytics (1 XRP revenue, 1 checked in, nothing pending), and in-app resale still closed while a ticket is unsold | Runs |
| Only someone who was checked in can review the event | Runs |
| An **NFT transfer fee** (`transfer-fee.testnet.test.ts`, XRPL-094): an investigation with its own fixtures, not app behaviour. An NFT minted with a 5% fee pays the issuer nothing on the issuer's own sale, 5% of a resale out of the seller's proceeds, and nothing on a free transfer. See `docs/xrpl/transfer-fees.md` | Runs |

The test waits for each validated ledger outcome by polling until it is final (`support/wait.ts`), never
for a fixed time.

## What is real and what is simulated

- **Real:** the app's services and database code, XRPL Testnet, and the faucet.
- **Simulated: the person approving in Xaman.** `support/auto-approve-xaman.ts` takes Xaman's place. It
  approves each request by signing exactly the transaction the server built (adding only fee, sequence
  and expiry, as Xaman does) with a throwaway wallet, then submits it.
- **Simulated: the session's wallet sign-in (XRPL-012).** That has its own tests. Here sessions start with
  the throwaway wallet as their proven wallet.
- **Check-in sign-ins are approved by the same double.** The test names the approving wallet with
  `xaman.signInWith(wallet)`. The double returns a blob in Xaman's SignIn format (`makeSignInBlob`),
  signed with that wallet's own Testnet key, and the app verifies it exactly as it would a real one.
  A sign-in is never submitted to the ledger.

Wallets are new faucet-funded Testnet accounts for every run. They live only in memory: nothing is saved
and no seed is printed. All ledger access goes through the app's XRPL module, which refuses anything but
Testnet or Devnet. The metadata URIs written to Testnet point at `http://localhost:3000`, which only
affects how explorers display the NFTs.

## Adding the next steps

- **A step that needs another person's wallet**: fund another wallet with `fundTestWallet()` and pass it to
  `AutoApproveXaman`, which signs for any wallet it was given (the purchase step does this for the buyer).
- **A step that needs a wallet sign-in** (not a transaction): call `xaman.signInWith(wallet)` before the
  app creates the sign-in request, as the check-in step does.
