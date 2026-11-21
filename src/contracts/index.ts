/**
 * Public contract barrel. Owner: Agent A (approves additions).
 *
 * Consumers import from `@/contracts` rather than reaching into slice files, so
 * the exported surface stays reviewable in one place. Each feature owner authors
 * its own slice and asks Agent A to export it here:
 *   common.ts    — Agent A   (primitives, API envelope, error codes)
 *   entities.ts  — Agent A   (stored-record DTOs + enums mirroring prisma/schema.prisma)
 *   auth.ts      — Agent A   (sessions, onboarding, account, demo personas)
 *   inventory.ts — Agent A   (primary availability and sell-out state)
 *   ownership.ts — Agent A   (ownership sync, transfer history)
 *   events.ts    — Agent C   (events, tiers, ticket/resale views, discovery, profiles)
 *   xrpl.ts      — Agent B   (ledger results, ownership, sign requests, offers)
 *   checkin.ts   — Agent D   (challenge, proof, CheckInResult, resale eligibility)
 *   friends.ts   — Agent D   (friend connections, blocks, friend-list visibility)
 *   reviews.ts   — Agent D   (event reviews: input, views, eligibility)
 *   commerce.ts  — Agent E
 *   community.ts — Agent E
 *
 * Slices import shared primitives from `common.ts` / `entities.ts` instead of
 * redeclaring them, so plain `export *` stays unambiguous. `tsc` fails with
 * TS2308 if two slices ever export the same name.
 */
export * from "./common";
export * from "./entities";
export * from "./auth";
export * from "./events";
export * from "./xrpl";
export * from "./checkin";
export * from "./inventory";
export * from "./ownership";
export * from "./commerce";
export * from "./friends";
export * from "./reviews";
