# Permissions (XRPL-013)

**Owner:** Agent A. **Code:** [`src/lib/auth/permissions.ts`](../../src/lib/auth/permissions.ts).

Hiding a link or button is never authorisation. Every route that reads private data or changes
anything checks the caller on the server, so a request sent directly to the API (curl, a script,
a modified page) is refused the same way.

## Who may do what

| Action | Who | Guard (after `requireSession(req)`) | Refusal |
|---|---|---|---|
| Create an event | SELLER or ORGANISER accounts | `requireEventManager(session)` | 403 `ONBOARDING_REQUIRED` / `ROLE_REQUIRED` |
| Edit an event, its tiers and inventory; publish; mint its tickets; list primary offers | The event's owner | `await requireEventOwner(db, session, eventId)` | 404 unknown event · 403 `NOT_EVENT_OWNER` |
| Run the event's gate scanner; see its inventory, check-in and analytics dashboards | The event's owner | `isEventOwner(db, userId, eventId)` (check-in uses it via `EventSellerAccess`) | 403 (`NOT_AUTHORISED` on check-in routes) |
| Buy a ticket, accept an offer, request a check-in code | Anyone with a proven wallet | `requireProvenWallet(session)` | 403 `WALLET_NOT_VERIFIED` |
| Create a resale, private (`Destination`) or gift offer for a ticket | The ticket's current holder on the XRP Ledger | `await requireTicketOwner(db, session, ticketId)` | 404 · 409 `TICKET_NOT_MINTED` · 403 `WALLET_NOT_VERIFIED` / `NOT_TICKET_OWNER` · 503 `LEDGER_UNAVAILABLE` |
| Change your own display name | The account itself | `PATCH /api/me` | 403 `ROLE_CHANGE_FORBIDDEN` for any role change |
| Choose a role | Once, CUSTOMER or SELLER only | `POST /api/onboarding` | 409 `ALREADY_ONBOARDED` · 400 for ORGANISER |

- **Event owner** = the account that created the event (`Event.sellerId`) while it is a SELLER or
  ORGANISER. A seller whose account is no longer an event manager loses access.
- **Ticket holder** = the proven wallet of the session (XRPL-012) holds the ticket's `NFTokenID` on a
  **validated** ledger (Agent B's `verifyOwner`). The app's cached owner (`TicketNFT.cachedOwnerAddress`)
  is never used for this. An unreadable or unvalidated ledger read gives 503, never "allowed".
- No session gives 401 `UNAUTHENTICATED` from `requireSession`.

## Using the guards

```ts
// POST /api/events/:id/tiers (Agent C, XRPL-016)
export const POST = withApiHandler(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id } = await ctx.params;
  await requireEventOwner(db, session, id); // 404 / 403 before anything changes
  // … validate input and write
});

// POST /api/tickets/:id/resale-offers (Agent B, XRPL-036)
const owner = await requireTicketOwner(db, session, ticketId); // ledger-verified holder
// build the NFTokenCreateOffer for owner.ownerAddress / owner.nftokenId
```

## What is enforced today

| Route | Enforcement |
|---|---|
| `GET /api/organisers/events/:id/metrics`, `/checkins` | event owner (via `EventSellerAccess` → `isEventOwner`) |
| `POST /api/checkin/verify`, `/confirm` | event owner (the check-in service's `OrganiserAccess`) |
| `/organiser/events/:id/{checkin,inventory,analytics}` pages | event owner |
| `PATCH /api/me`, `POST /api/onboarding` | own account; no role escalation |

The event, tier, mint and offer write routes don't exist yet (XRPL-015..017, 024..041). Their owners call
the guards above. Tests in `src/lib/auth/permissions.int.test.ts` call the existing routes directly as the
wrong user to prove they're refused.

## Not covered (yet)

- **Gate staff assignment:** only the event's owner can scan. There is no way to let a separate ORGANISER
  account (e.g. the seeded `Door Team`) scan someone else's event. The demo runs the scanner as the
  event's seller. Add an event-staff table if a demo needs separate door staff.
- **Admin role:** none. Role changes happen only through seeding or the database.
