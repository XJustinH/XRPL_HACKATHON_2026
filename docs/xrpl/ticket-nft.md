# Ticket NFTs: metadata and identity (Agent B, XRPL-022)

Each admission ticket is one XRPL NFT, minted by the seller's own wallet. This page defines what the
NFT carries and how it maps to the app's records. Code: `src/lib/xrpl/tickets/metadata.ts`. Contract:
`TicketNftMetadata` in `src/contracts/xrpl.ts`.

## Identity

| Fact | Where it lives | Rule |
|---|---|---|
| Ticket record | `TicketNFT` row (Agent A's schema) | One row per intended ticket: event, tier and a 1-based `serial` unique within the tier |
| NFT | XRPL `NFTokenID` | Set on the row **only** from a validated `NFTokenMint` (XRPL-024). `TicketNFT.nftokenId` is unique, so one NFT maps to one ticket |
| Link from NFT to ticket | Metadata `ticket.ticketId`, through the NFT's URI | The URI is unique per ticket (XRPL-023), so one ticket maps to one NFT |
| Issuer | Seller wallet that signs the mint | Recorded from the validated transaction's `Account`, never from the browser |
| Current holder | The ledger | Never stored in metadata. Read with `verifyOwner()` / `getOwner()` (XRPL-007) |

## On-ledger settings

| Field | Value | Why |
|---|---|---|
| `Flags` | `tfTransferable` only | Holders can resell or gift (XRPL-036/040/041). Not `tfBurnable`, so the issuer cannot destroy a ticket someone else holds |
| `TransferFee` | none (0) | Royalties are a separate P2 spike (XRPL-094) |
| `NFTokenTaxon` | `ticketTaxon(eventId)`: the first 32 bits of the event UUID | Groups an issuer's tickets per event; stable and needs no storage |
| `URI` | Hex of the ticket's metadata URL (≤ 256 bytes) | Points to the JSON below (XRPL-023) |

## Metadata JSON

Served publicly at the ticket's URI. It follows the XLS-24 layout so wallets and explorers can show it:

```json
{
  "schema": "xrpl-ticketing/ticket@1",
  "nftType": "ticket.v1",
  "name": "<event title> — <tier name> #<serial>",
  "description": "Admission ticket NFT for <event> at <venue>, <city>. <event description>",
  "image": "<event artwork URL, or the generated ticket image>",
  "collection": { "name": "<event title>", "family": "XRPL Ticketing" },
  "attributes": [
    { "trait_type": "Event", "value": "..." },
    { "trait_type": "Tier", "value": "..." },
    { "trait_type": "Serial", "value": 1 },
    { "trait_type": "Venue", "value": "..." },
    { "trait_type": "City", "value": "..." },
    { "trait_type": "Starts", "value": "2027-03-12T20:00:00.000Z" }
  ],
  "ticket": {
    "ticketId": "<TicketNFT.id>", "eventId": "...", "tierId": "...",
    "serial": 1, "issuer": "r...", "network": "TESTNET"
  },
  "event": { "title": "...", "startsAt": "...", "endsAt": "...", "venue": "...", "city": "..." },
  "tier": { "name": "...", "priceDrops": "2500000" }
}
```

- **No attendee information.** Buyers and holders are never named, and there are no emails, display
  names or user IDs. Who holds a ticket is a ledger fact, read live.
- `priceDrops` is the tier's face value at mint, in drops, as an integer string.
- `schema` is versioned. A future change bumps it, so readers can tell the shapes apart.
