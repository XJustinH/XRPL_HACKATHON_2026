/**
 * Agent D contract slice: check-in (XRPL-044..047) and the in-app resale rule (XRPL-037).
 *
 * Resale eligibility itself uses `ResaleEligibility` from `events.ts` (consumed by the UI);
 * this slice adds the check-in types and the shared limitation notice.
 */
import { z } from "zod";
import { AppId, type IsoDateTime, type NFTokenId, type XrplAddress } from "./common";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** POST /api/checkin/challenges. Wallet comes from the verified session, never the body. */
export const CheckInChallengeRequest = z.object({ ticketId: AppId });
export type CheckInChallengeRequest = z.infer<typeof CheckInChallengeRequest>;

/** POST /api/checkin/challenges/:id/prove */
export const CheckInProveRequest = z.object({ proof: z.string().min(1).max(8192) });
export type CheckInProveRequest = z.infer<typeof CheckInProveRequest>;

/** POST /api/checkin/verify and /api/checkin/confirm (organiser scanner). */
export const CheckInScanRequest = z.object({
  qrPayload: z.string().min(1).max(200),
  eventId: AppId,
});
export type CheckInScanRequest = z.infer<typeof CheckInScanRequest>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type CheckInChallengeIssued = {
  challengeId: string;
  eventId: string;
  ticketId: string;
  expiresAt: IsoDateTime;
  /** Opaque HMAC-tagged string for the QR. Contains no address, seed or personal data. */
  qrPayload: string;
  /** Exact text the attendee's wallet must sign to prove control (XRPL-045). */
  messageToSign: string;
};

export const CHECKIN_FAILURE_STATUSES = [
  "INVALID_QR", // malformed or tampered QR payload
  "UNKNOWN_TICKET", // challenge or ticket does not exist, or ticket not minted
  "NOT_AUTHORISED", // scanner is not an organiser for this event
  "WRONG_EVENT", // ticket/challenge belongs to a different event
  "EXPIRED", // challenge past its expiry
  "PROOF_REQUIRED", // attendee has not yet proven wallet control
  "INVALID_PROOF", // bad, replayed, or wrong-wallet proof
  "WRONG_OWNER", // ledger owner is not the proven wallet (e.g. transferred away)
  "ALREADY_USED", // ticket already checked in or challenge consumed
  "LEDGER_UNAVAILABLE", // ownership could not be confirmed on XRPL; never admit
] as const;
export type CheckInFailureStatus = (typeof CHECKIN_FAILURE_STATUSES)[number];
export type CheckInFailure = { status: CheckInFailureStatus; message: string };

export type CheckInProven = { status: "PROVEN"; challengeId: string };

export type CheckInVerification =
  | {
      status: "VERIFIED";
      challengeId: string;
      ticketId: string;
      eventId: string;
      nftokenId: NFTokenId;
      ownerAddress: XrplAddress;
      /** Validated ledger the ownership was read from (null if the node did not report one). */
      ledgerIndex: number | null;
    }
  | CheckInFailure;

export type CheckInResult =
  | { status: "ADMITTED"; ticketId: string; eventId: string; checkedInAt: IsoDateTime; ledgerIndex: number | null }
  | CheckInFailure;

/** HTTP status for each failure; failures are returned as `{ error: { code: status } }`. */
export const CHECKIN_HTTP_STATUS: Record<CheckInFailureStatus, number> = {
  INVALID_QR: 400,
  INVALID_PROOF: 401,
  NOT_AUTHORISED: 403,
  WRONG_EVENT: 403,
  WRONG_OWNER: 403,
  UNKNOWN_TICKET: 404,
  PROOF_REQUIRED: 409,
  ALREADY_USED: 409,
  EXPIRED: 410,
  LEDGER_UNAVAILABLE: 503,
};

// ---------------------------------------------------------------------------
// Resale
// ---------------------------------------------------------------------------

/** Must be shown wherever resale is offered or explained. The rule is app-only. */
export const RESALE_LIMITATION_NOTICE =
  "Resale tickets are only listed in this app once every primary ticket has sold. " +
  "This is an app rule: ticket NFTs are transferable, so holders can still sell or " +
  "transfer them directly on the XRP Ledger outside this app.";

// ---------------------------------------------------------------------------
// Organiser overview (XRPL-048)
// ---------------------------------------------------------------------------

/** GET /api/organisers/events/:id/checkins */
export type CheckInOverview = {
  eventId: string;
  /** Tickets with a validated mint for this event. */
  mintedTickets: number;
  admitted: number;
  /** Most recent admissions first. */
  recent: {
    ticketId: string;
    serial: number;
    tierName: string;
    walletAddress: XrplAddress;
    scannedAt: IsoDateTime;
  }[];
};
