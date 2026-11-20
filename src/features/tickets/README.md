# src/features/tickets — Agent B

Ticket ownership presentation (XRPL-028). Client code only: it calls `GET /api/tickets/:id/ownership`.
How ownership is read and what each status means is in [docs/xrpl/ownership.md](../../../docs/xrpl/ownership.md).

| File | What |
|---|---|
| `ownership-badge.tsx` | One ticket's current holder, read from a validated ledger when shown: "In your wallet", "Held by r…", or "Ownership pending" with the reason. Never shows a ticket as owned unless the ledger verified it, and notes when it changed hands |

Usage, in Agent C's My tickets or ticket view (XRPL-033/034):

```tsx
<OwnershipBadge ticketId={ticket.id} />
```

For the lists themselves, server components call `listTicketsForOwner` / `getTicketView` from
`@/lib/xrpl/tickets/ownership`, wired with `mintingDeps()`.
