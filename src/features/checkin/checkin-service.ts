/**
 * Check-in core (XRPL-044 challenge/QR, XRPL-045 wallet-control proof,
 * XRPL-046 ledger validation, XRPL-047 atomic one-time admission).
 *
 *  1. Attendee (session with verified wallet) -> issueChallenge(): 2-minute, event-bound
 *     challenge, shown as a QR plus a message for their wallet to sign.
 *  2. Attendee wallet signs -> proveControl(): proof must be from the challenge's wallet,
 *     over this challenge's message, and is accepted once.
 *  3. Organiser scans -> verifyScan(): read-only preview.
 *  4. Organiser confirms -> admit(): re-runs every check including a fresh ledger owner
 *     read, then consumes the challenge and records the check-in in one transaction.
 *
 * The QR holds only `xtc1.<challengeId>.<hmac>`: no address, seed or personal data.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CheckInChallengeIssued,
  CheckInFailure,
  CheckInFailureStatus,
  CheckInProven,
  CheckInResult,
  CheckInVerification,
} from "@/contracts/checkin";
import type { XrplAddress } from "@/contracts/common";
import {
  type CheckInStore,
  type Clock,
  type LedgerOwnership,
  type OwnershipCheck,
  type OrganiserAccess,
  type StoredChallenge,
  type TicketDirectory,
  type WalletProofVerifier,
  LedgerUnavailableError,
  systemClock,
} from "./ports";

const QR_PREFIX = "xtc1";
export const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000;

export type CheckInServiceDeps = {
  tickets: TicketDirectory;
  organisers: OrganiserAccess;
  ledger: LedgerOwnership;
  proofs: WalletProofVerifier;
  store: CheckInStore;
  clock?: Clock;
};

export type CheckInServiceOptions = {
  /** Server-only secret for QR tags (CHECKIN_QR_SECRET), at least 32 bytes. */
  qrSecret: string;
  challengeTtlMs?: number;
};

type ScanInput = { qrPayload: string; organiserId: string; gateEventId: string };
type Checked = { challenge: StoredChallenge; nftokenId: string; ledgerIndex: number | null };

const fail = (status: CheckInFailureStatus, message: string): CheckInFailure => ({ status, message });
const isFailure = (x: object): x is CheckInFailure => "status" in x;

export class CheckInService {
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(
    private readonly deps: CheckInServiceDeps,
    private readonly options: CheckInServiceOptions,
  ) {
    if (Buffer.byteLength(options.qrSecret) < 32) throw new Error("qrSecret must be at least 32 bytes");
    this.clock = deps.clock ?? systemClock;
    this.ttlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  }

  /** XRPL-044. `walletAddress` must be the session's verified wallet, never request input. */
  async issueChallenge(input: {
    ticketId: string;
    walletAddress: XrplAddress;
  }): Promise<CheckInChallengeIssued | CheckInFailure> {
    const ticket = await this.deps.tickets.findTicket(input.ticketId);
    if (!ticket) return fail("UNKNOWN_TICKET", "Ticket not found.");
    if (!ticket.nftokenId) return fail("UNKNOWN_TICKET", "This ticket has not been minted yet.");

    if (await this.deps.store.hasCheckIn(ticket.ticketId, ticket.eventId)) {
      return fail("ALREADY_USED", "This ticket has already been used to enter the event.");
    }

    const owner = await this.checkOwner(ticket.nftokenId, input.walletAddress);
    if (isFailure(owner)) return owner;
    if (!owner.owns) return fail("WRONG_OWNER", "Your linked wallet does not currently hold this ticket.");

    const challenge: StoredChallenge = {
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      ticketId: ticket.ticketId,
      eventId: ticket.eventId,
      walletAddress: input.walletAddress,
      expiresAt: new Date(this.clock.now().getTime() + this.ttlMs),
      consumedAt: null,
      proofReference: null,
    };
    await this.deps.store.createChallenge(challenge);

    return {
      challengeId: challenge.id,
      eventId: challenge.eventId,
      ticketId: challenge.ticketId,
      expiresAt: challenge.expiresAt.toISOString(),
      qrPayload: `${QR_PREFIX}.${challenge.id}.${this.tagFor(challenge)}`,
      messageToSign: buildMessageToSign(challenge, ticket.nftokenId),
    };
  }

  /** XRPL-045. */
  async proveControl(input: { challengeId: string; proof: string }): Promise<CheckInProven | CheckInFailure> {
    const challenge = await this.deps.store.getChallenge(input.challengeId);
    if (!challenge) return fail("UNKNOWN_TICKET", "Check-in request not found.");
    if (challenge.consumedAt) return fail("ALREADY_USED", "This check-in request has already been used.");
    if (this.isExpired(challenge)) return fail("EXPIRED", "This check-in request has expired. Generate a new one.");
    if (challenge.proofReference) return fail("INVALID_PROOF", "This check-in request has already been approved.");

    const ticket = await this.deps.tickets.findTicket(challenge.ticketId);
    if (!ticket?.nftokenId) return fail("UNKNOWN_TICKET", "Ticket not found.");

    const signer = await this.deps.proofs.verify(buildMessageToSign(challenge, ticket.nftokenId), input.proof);
    if (!signer) return fail("INVALID_PROOF", "Wallet proof could not be verified.");
    if (signer !== challenge.walletAddress) {
      return fail("INVALID_PROOF", "Proof was signed by a different wallet than the ticket holder.");
    }

    if (!(await this.deps.store.markProven(challenge.id, proofFingerprint(input.proof)))) {
      return fail("INVALID_PROOF", "This check-in request has already been approved.");
    }
    return { status: "PROVEN", challengeId: challenge.id };
  }

  /** XRPL-046. Read-only preview for the organiser's scanner. */
  async verifyScan(input: ScanInput): Promise<CheckInVerification> {
    const checked = await this.runChecks(input);
    if (isFailure(checked)) return checked;
    const { challenge, nftokenId, ledgerIndex } = checked;
    return {
      status: "VERIFIED",
      challengeId: challenge.id,
      ticketId: challenge.ticketId,
      eventId: challenge.eventId,
      nftokenId,
      ownerAddress: challenge.walletAddress,
      ledgerIndex,
    };
  }

  /** XRPL-047. Re-verifies everything, then admits at most once. */
  async admit(input: ScanInput): Promise<CheckInResult> {
    const checked = await this.runChecks(input);
    if (isFailure(checked)) return checked;
    const { challenge, ledgerIndex } = checked;

    const scannedAt = this.clock.now();
    const outcome = await this.deps.store.admitAtomically({
      ticketId: challenge.ticketId,
      eventId: challenge.eventId,
      challengeId: challenge.id,
      organiserId: input.organiserId,
      walletAddress: challenge.walletAddress,
      verifiedLedgerIndex: ledgerIndex,
      scannedAt,
    });
    if (outcome !== "ADMITTED") return fail("ALREADY_USED", "This ticket has already been checked in.");
    return {
      status: "ADMITTED",
      ticketId: challenge.ticketId,
      eventId: challenge.eventId,
      checkedInAt: scannedAt.toISOString(),
      ledgerIndex,
    };
  }

  // -------------------------------------------------------------------------

  private async runChecks(input: ScanInput): Promise<Checked | CheckInFailure> {
    const parsed = parseQr(input.qrPayload);
    if (!parsed) return fail("INVALID_QR", "Not a valid check-in code.");
    const challenge = await this.deps.store.getChallenge(parsed.challengeId);
    if (!challenge || !safeEqual(parsed.tag, this.tagFor(challenge))) {
      return fail("INVALID_QR", "Not a valid check-in code.");
    }

    if (!(await this.deps.organisers.canScanEvent(input.organiserId, input.gateEventId))) {
      return fail("NOT_AUTHORISED", "You are not an organiser for this event.");
    }
    if (challenge.eventId !== input.gateEventId) return fail("WRONG_EVENT", "This ticket is for a different event.");

    const ticket = await this.deps.tickets.findTicket(challenge.ticketId);
    if (!ticket?.nftokenId) return fail("UNKNOWN_TICKET", "Ticket not found.");
    if (ticket.eventId !== challenge.eventId) return fail("WRONG_EVENT", "Ticket does not match this event.");

    if (challenge.consumedAt || (await this.deps.store.hasCheckIn(challenge.ticketId, challenge.eventId))) {
      return fail("ALREADY_USED", "This ticket has already been checked in.");
    }
    if (this.isExpired(challenge)) return fail("EXPIRED", "Check-in code expired. Ask the attendee to refresh it.");
    if (!challenge.proofReference) {
      return fail("PROOF_REQUIRED", "The attendee has not approved this check-in in their wallet.");
    }

    const owner = await this.checkOwner(ticket.nftokenId, challenge.walletAddress);
    if (isFailure(owner)) return owner;
    if (!owner.owns) return fail("WRONG_OWNER", "This ticket is no longer held by the wallet that presented it.");
    return { challenge, nftokenId: ticket.nftokenId, ledgerIndex: owner.ledgerIndex };
  }

  private async checkOwner(nftokenId: string, address: XrplAddress): Promise<OwnershipCheck | CheckInFailure> {
    try {
      return await this.deps.ledger.checkOwner(nftokenId, address);
    } catch (err) {
      if (err instanceof LedgerUnavailableError) {
        return fail("LEDGER_UNAVAILABLE", "Could not reach the XRP Ledger to confirm ownership. Do not admit; retry.");
      }
      throw err;
    }
  }

  private isExpired(c: StoredChallenge): boolean {
    return this.clock.now().getTime() >= c.expiresAt.getTime();
  }

  private tagFor(c: StoredChallenge): string {
    return createHmac("sha256", this.options.qrSecret)
      .update(["v1", c.id, c.eventId, c.ticketId, c.expiresAt.getTime()].join("|"))
      .digest("base64url");
  }
}

// ---------------------------------------------------------------------------

export function buildMessageToSign(
  c: Pick<StoredChallenge, "id" | "nonce" | "eventId" | "expiresAt">,
  nftokenId: string,
): string {
  return [
    "XRPL ticket check-in",
    `challenge: ${c.id}`,
    `nonce: ${c.nonce}`,
    `event: ${c.eventId}`,
    `ticket NFT: ${nftokenId}`,
    `expires: ${c.expiresAt.toISOString()}`,
  ].join("\n");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseQr(payload: string): { challengeId: string; tag: string } | null {
  if (typeof payload !== "string" || payload.length > 200) return null;
  const parts = payload.trim().split(".");
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
  const [, challengeId = "", tag = ""] = parts;
  if (!UUID_RE.test(challengeId) || !/^[A-Za-z0-9_-]{43}$/.test(tag)) return null;
  return { challengeId, tag };
}

function proofFingerprint(proof: string): string {
  return `sha256:${createHash("sha256").update(proof).digest("hex")}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
