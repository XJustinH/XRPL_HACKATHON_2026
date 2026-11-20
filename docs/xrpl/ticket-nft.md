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

## Publishing the metadata (XRPL-023)

| Route | Returns |
|---|---|
| `GET /api/tickets/:id/metadata` | The ticket's `TicketNftMetadata` as **raw JSON**, not the `{ data }` envelope, because wallets and explorers read metadata at the top level. Public, `Access-Control-Allow-Origin: *`, 404 for unknown tickets |
| `GET /api/tickets/:id/image` | Generated SVG ticket artwork. Used as `image` when the event has no https artwork. All text is XML-escaped, nothing external is loaded, and it is served with `Content-Security-Policy: default-src 'none'` |

- **One URI per ticket:** `<base>/api/tickets/<ticketId>/metadata`. It is stored in `TicketNFT.metadataUri`
  when the ticket is reserved (`createPendingTicket`, `src/lib/xrpl/tickets/store.ts`) and written into
  the NFT at mint (XRPL-024).
- **Base URL:** `TICKET_METADATA_BASE_URL`, falling back to `APP_BASE_URL`. **It must be the app's public
  https address in any shared environment**; once a URI is on the ledger it cannot change. Locally it is
  `http://localhost:3000`, which wallets and explorers cannot reach, and `isPubliclyReachable()` reports
  that. Test mints made locally will not show an image in Xaman or on the explorer.
- Reserving a ticket allocates the next serial in the tier. It reuses a ticket whose mint failed (it
  never produced an NFT), and counts PENDING, SUBMITTED and MINTED tickets against the tier's supply
  (409 when the tier is full).
- **Limitation:** the JSON is rendered from the current event and tier records. If a seller edits an
  event after minting, the served metadata follows the edit. Freezing it would need either a stored
  snapshot (a schema request to Agent A) or content-addressed storage (IPFS/S3), as a follow-up.
