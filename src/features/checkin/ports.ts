/**
 * Interfaces the check-in core depends on.
 *  - CheckInStore, TicketDirectory: Prisma implementations in ./prisma-store.ts (schema XRPL-005)
 *  - OrganiserAccess: Agent A roles (XRPL-013)
 *  - LedgerOwnership: Agent B `getOwner` from a validated ledger (XRPL-028)
 *  - WalletProofVerifier: Agent A/B wallet-control proof (XRPL-012, e.g. Xaman SignIn)
 * In-memory fakes for tests live in ./testing/fakes.ts.
 */
import type { NFTokenId, XrplAddress } from "@/contracts/common";

export type TicketRef = {
  ticketId: string;
  eventId: string;
  /** Null until the mint is validated; an unminted ticket cannot be checked in. */
  nftokenId: NFTokenId | null;
};

export interface TicketDirectory {
  findTicket(ticketId: string): Promise<TicketRef | null>;
}

export interface OrganiserAccess {
  canScanEvent(organiserId: string, eventId: string): Promise<boolean>;
}

export type LedgerOwner = { ownerAddress: XrplAddress; ledgerIndex: number };

/** Thrown by LedgerOwnership when XRPL cannot be queried. Never treated as success. */
export class LedgerUnavailableError extends Error {
  constructor(message = "XRPL ledger unavailable") {
    super(message);
    this.name = "LedgerUnavailableError";
  }
}

export interface LedgerOwnership {
  /** Owner per a validated ledger; null if the token does not exist. Throws LedgerUnavailableError. */
  getOwner(nftokenId: NFTokenId): Promise<LedgerOwner | null>;
}

export interface WalletProofVerifier {
  /** Address that signed exactly `message` with `proof`, or null if the proof is invalid. */
  verify(message: string, proof: string): Promise<XrplAddress | null>;
}

/** Mirrors the `CheckInChallenge` table. `proofReference` set means wallet control was proven. */
export type StoredChallenge = {
  id: string;
  nonce: string;
  ticketId: string;
  eventId: string;
  walletAddress: XrplAddress;
  expiresAt: Date;
  consumedAt: Date | null;
  proofReference: string | null;
};

export type NewCheckInRecord = {
  ticketId: string;
  eventId: string;
  challengeId: string;
  organiserId: string;
  walletAddress: XrplAddress;
  verifiedLedgerIndex: number;
  scannedAt: Date;
};

export type AdmitOutcome = "ADMITTED" | "CHALLENGE_ALREADY_CONSUMED" | "TICKET_ALREADY_CHECKED_IN";

export interface CheckInStore {
  createChallenge(challenge: StoredChallenge): Promise<void>;
  getChallenge(id: string): Promise<StoredChallenge | null>;
  /** Conditional update: sets proofReference only if it is still null. False otherwise. */
  markProven(id: string, proofReference: string): Promise<boolean>;
  hasCheckIn(ticketId: string, eventId: string): Promise<boolean>;
  /**
   * One transaction: consume the challenge only if unconsumed, and insert the check-in
   * record (unique on ticketId+eventId). Both happen or neither.
   */
  admitAtomically(record: NewCheckInRecord): Promise<AdmitOutcome>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
