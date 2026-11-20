/**
 * Public contract barrel. Owner: Agent A (approves additions).
 *
 * Each feature owner authors its own domain file and asks Agent A to export it here:
 *   events.ts    — Agent C   (event/tier request + response shapes)
 *   xrpl.ts      — Agent B   (ledger results, ownership, sign requests, offers)
 *   checkin.ts   — Agent D   (challenge, proof, CheckInResult, resale eligibility)
 *   commerce.ts  — Agent E
 *   community.ts — Agent E
 *   auth.ts      — Agent A   (XRPL-010/012)
 */
export * from "./common";
export * from "./entities";
