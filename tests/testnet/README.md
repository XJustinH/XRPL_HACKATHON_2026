# Live Testnet lifecycle test (XRPL-050)

Runs the ticket lifecycle against the real XRPL Testnet, so we know the app works with the actual ledger,
not just with fakes.

```bash
npm run db:up          # Postgres, if it isn't running
npm run test:testnet   # about 30 seconds; needs the internet
```

It is **not part of CI or `npm test`**: it depends on the public Testnet and its faucet, which can be slow
or down. Run it before merging ledger changes and before the demo rehearsal. It uses the same `*_test`
database as `npm run test:db` and wipes it, so don't run the two at the same time.

## What it checks

| Step | Status |
|---|---|
| Mint a ticket NFT. The ticket becomes `MINTED` only from the validated ledger result, and is recorded exactly once | Runs |
| Look up the NFT on the ledger: the seller's wallet holds it, and it is transferable with the ticket's metadata URI | Runs |
| Primary sell offer | To do: needs XRPL-029 |
| A buyer accepts the offer and becomes the owner | To do: needs XRPL-031 |
| Resale or private transfer to a friend | To do: needs XRPL-036, XRPL-039, XRPL-040 |
| The holder checks in once, and a second check-in is rejected | To do: needs XRPL-045, XRPL-047 |

The test waits for each validated ledger outcome by polling until it is final (`support/wait.ts`), never
for a fixed time.

## What is real and what is simulated

- **Real:** the app's services and database code, XRPL Testnet, and the faucet.
- **Simulated: the person approving in Xaman.** `support/auto-approve-xaman.ts` takes Xaman's place. It
  approves each request by signing exactly the transaction the server built (adding only fee, sequence
  and expiry, as Xaman does) with a throwaway wallet, then submits it.
- **Simulated: the wallet sign-in proof (XRPL-012).** That has its own tests. Here the seller's session
  starts with the throwaway wallet as its proven wallet.

Wallets are new faucet-funded Testnet accounts for every run. They live only in memory: nothing is saved
and no seed is printed. All ledger access goes through the app's XRPL module, which refuses anything but
Testnet or Devnet. The metadata URIs written to Testnet point at `http://localhost:3000`, which only
affects how explorers display the NFTs.

## Adding the next steps

- **A step that needs another person's wallet**, such as a buyer accepting an offer: fund another wallet
  with `fundTestWallet()` and pass it to `AutoApproveXaman`, which signs for any wallet it was given.
- **Check-in** proves wallet control with a Xaman sign-in rather than a transaction. The double will need
  to answer sign-in requests too.
