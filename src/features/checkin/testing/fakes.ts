/** In-memory stand-ins for other agents' services. Test/demo use only. */
import type { NFTokenId, XrplAddress } from "@/contracts/common";
import {
  type AdmitOutcome,
  type CheckInStore,
  type Clock,
  type LedgerOwnership,
  type NewCheckInRecord,
  type OrganiserAccess,
  type StoredChallenge,
  type TicketDirectory,
  type TicketRef,
  type WalletProofVerifier,
  LedgerUnavailableError,
} from "../ports";

export class FakeClock implements Clock {
  constructor(private t = new Date("2026-12-01T19:00:00.000Z").getTime()) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeTickets implements TicketDirectory {
  readonly tickets = new Map<string, TicketRef>();
  add(t: TicketRef) {
    this.tickets.set(t.ticketId, t);
  }
  async findTicket(id: string) {
    return this.tickets.get(id) ?? null;
  }
}

export class FakeOrganisers implements OrganiserAccess {
  readonly grants = new Set<string>();
  grant(organiserId: string, eventId: string) {
    this.grants.add(`${organiserId}|${eventId}`);
  }
  async canScanEvent(organiserId: string, eventId: string) {
    return this.grants.has(`${organiserId}|${eventId}`);
  }
}

export class FakeLedger implements LedgerOwnership {
  readonly owners = new Map<NFTokenId, XrplAddress>();
  ledgerIndex = 1000;
  down = false;
  async checkOwner(id: NFTokenId, address: XrplAddress) {
    if (this.down) throw new LedgerUnavailableError();
    return { owns: this.owners.get(id) === address, ledgerIndex: this.ledgerIndex };
  }
}

/** Test-only proof format `signed:<address>:<hash of message>`. Not a real signature scheme. */
export class FakeProofs implements WalletProofVerifier {
  static sign(address: XrplAddress, message: string) {
    return `signed:${address}:${simpleHash(message)}`;
  }
  async verify(message: string, proof: string) {
    const [kind, address, digest] = proof.split(":");
    if (kind !== "signed" || !address || digest !== simpleHash(message)) return null;
    return address;
  }
}

function simpleHash(s: string) {
  let h = 0;
  for (const ch of s) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16);
}

/** Same semantics as the Prisma store. JS is single-threaded, so each method body is atomic. */
export class InMemoryCheckInStore implements CheckInStore {
  readonly challenges = new Map<string, StoredChallenge>();
  readonly records = new Map<string, NewCheckInRecord>();

  async createChallenge(c: StoredChallenge) {
    this.challenges.set(c.id, { ...c });
  }
  async getChallenge(id: string) {
    const c = this.challenges.get(id);
    return c ? { ...c } : null;
  }
  async markProven(id: string, proofReference: string) {
    const c = this.challenges.get(id);
    if (!c || c.proofReference) return false;
    c.proofReference = proofReference;
    return true;
  }
  async hasCheckIn(ticketId: string, eventId: string) {
    return this.records.has(`${ticketId}|${eventId}`);
  }
  async admitAtomically(r: NewCheckInRecord): Promise<AdmitOutcome> {
    const c = this.challenges.get(r.challengeId);
    if (!c || c.consumedAt) return "CHALLENGE_ALREADY_CONSUMED";
    const key = `${r.ticketId}|${r.eventId}`;
    if (this.records.has(key)) return "TICKET_ALREADY_CHECKED_IN";
    c.consumedAt = r.scannedAt;
    this.records.set(key, { ...r });
    return "ADMITTED";
  }
}
