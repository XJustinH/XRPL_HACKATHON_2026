/**
 * Public contract barrel. Owner: Agent A (approves additions).
 *
 * Consumers import from `@/contracts` rather than reaching into slice files, so
 * the exported surface stays reviewable in one place. Each feature owner authors
 * its own slice and asks Agent A to export it here:
 *   common.ts    — Agent A   (primitives, API envelope, error codes)
 *   entities.ts  — Agent A   (stored-record DTOs + enums mirroring prisma/schema.prisma)
 *   events.ts    — Agent C   (events, tiers, ticket/resale views, discovery, profiles)
 *   xrpl.ts      — Agent B   (ledger results, ownership, sign requests, offers)
 *   checkin.ts   — Agent D   (challenge, proof, CheckInResult, resale eligibility)
 *   commerce.ts  — Agent E
 *   community.ts — Agent E
 */
export * from "./common";
export * from "./entities";
export * from "./events";
export * from "./xrpl";

// Names declared in more than one slice. The explicit export picks the canonical
// definition (common.ts / entities.ts, which match the database) and resolves the
// `export *` ambiguity.
export { Drops, TxHash, type ApiSuccess, type ApiResponse } from "./common";
export { EventStatus, OfferKind, OfferState } from "./entities";
