import type { PrismaClient } from "@/generated/prisma/client";
import { AuthErrorCode, EVENT_MANAGER_ROLES, ErrorCode, type UserRole } from "@/contracts";
import { AppError, errors } from "@/lib/http/response";
import { getXrplQueryService, toLedgerAppError } from "@/lib/xrpl";
import type { AuthSession } from "./session";

/**
 * Server-side permissions (XRPL-013). Owner: Agent A.
 *
 * Every route that changes data calls one of these after `requireSession(req)`. Hidden
 * navigation is never authorisation: these checks run on the server for every request.
 *
 * | Action                                          | Guard                         |
 * |-------------------------------------------------|-------------------------------|
 * | Create an event (seller-only action)            | `requireEventManager`         |
 * | Edit an event, its tiers/inventory, mint, list  | `requireEventOwner`           |
 * | Run an event's gate scanner, see its dashboards | `isEventOwner` / `eventAccess`|
 * | Buy, accept an offer, request a check-in code   | `requireProvenWallet`         |
 * | Create a resale, private or gift offer          | `requireTicketOwner`          |
 *
 * Responses: 401 without a session (from `requireSession`), 403 with a specific code when the
 * account may not act, 404 for a missing event/ticket, 409 for an unminted ticket, 503 when the
 * ledger can't be read (never treated as "allowed").
 */

const isEventManagerRole = (role: UserRole) => (EVENT_MANAGER_ROLES as readonly UserRole[]).includes(role);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** 403 unless the account has chosen a role and it is one of `roles`. */
export function requireRole(session: AuthSession, roles: readonly UserRole[]): void {
  if (!session.onboardedAt) {
    throw new AppError(AuthErrorCode.ONBOARDING_REQUIRED, "Choose how you'll use the app first.", 403);
  }
  if (!roles.includes(session.role)) {
    throw new AppError(AuthErrorCode.ROLE_REQUIRED, "Your account type can't do this.", 403);
  }
}

/** Seller-only actions such as creating an event: SELLER or ORGANISER accounts. */
export function requireEventManager(session: AuthSession): void {
  requireRole(session, EVENT_MANAGER_ROLES);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type EventDb = Pick<PrismaClient, "event">;

/**
 * The event's owner: the account that created it (`Event.sellerId`), while that account is an
 * event manager (SELLER/ORGANISER). Owners edit the event and its inventory and run its scanner.
 */
export async function isEventOwner(db: EventDb, userId: string, eventId: string): Promise<boolean> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { sellerId: true, seller: { select: { role: true } } },
  });
  return !!event && event.sellerId === userId && isEventManagerRole(event.seller.role);
}

/** 404 if the event doesn't exist, 403 unless the session's account owns it. */
export async function requireEventOwner(
  db: EventDb,
  session: AuthSession,
  eventId: string,
): Promise<{ id: string; sellerId: string; status: "DRAFT" | "PUBLISHED" }> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { id: true, sellerId: true, status: true },
  });
  if (!event) throw errors.notFound("Event not found");
  if (event.sellerId !== session.userId || !isEventManagerRole(session.role)) {
    throw new AppError(AuthErrorCode.NOT_EVENT_OWNER, "Only this event's organiser can do this.", 403);
  }
  return event;
}

/**
 * Who may scan tickets at an event's gate and see its organiser dashboards: its owner.
 * Satisfies the check-in `OrganiserAccess` port (src/features/checkin/ports.ts).
 */
export function eventAccess(db: EventDb): { canScanEvent(userId: string, eventId: string): Promise<boolean> } {
  return { canScanEvent: (userId, eventId) => isEventOwner(db, userId, eventId) };
}

// ---------------------------------------------------------------------------
// Wallets and tickets
// ---------------------------------------------------------------------------

/** 403 unless this session has a server-verified wallet (XRPL-012). Returns its address. */
export function requireProvenWallet(session: AuthSession): string {
  if (!session.walletAddress) {
    throw new AppError(AuthErrorCode.WALLET_NOT_VERIFIED, "Connect your Xaman wallet first.", 403);
  }
  return session.walletAddress;
}

/** The part of Agent B's read service this needs (structural, so tests can fake it). */
export type OwnerVerifier = {
  verifyOwner(
    nftokenId: string,
    address: string,
  ): Promise<{ owns: boolean; provenance: { ledgerIndex: number | null; validated: boolean } }>;
};

type TicketDb = Pick<PrismaClient, "ticketNFT">;

export type VerifiedTicketOwner = {
  ticketId: string;
  eventId: string;
  nftokenId: string;
  ownerAddress: string;
  ledgerIndex: number | null;
};

/**
 * Only the ticket's current holder may create resale, private or gift offers for it.
 * Ownership is read from a validated XRPL ledger, never from the app's cached owner.
 *  - 404 unknown ticket · 409 not minted yet · 403 no proven wallet / not the holder
 *  - 503 if the ledger can't be read or the read isn't from a validated ledger
 */
export async function requireTicketOwner(
  db: TicketDb,
  session: AuthSession,
  ticketId: string,
  ledger: OwnerVerifier = getXrplQueryService(),
): Promise<VerifiedTicketOwner> {
  const ticket = await db.ticketNFT.findUnique({
    where: { id: ticketId },
    select: { id: true, eventId: true, nftokenId: true },
  });
  if (!ticket) throw errors.notFound("Ticket not found");
  if (!ticket.nftokenId) {
    throw new AppError(AuthErrorCode.TICKET_NOT_MINTED, "This ticket isn't on the ledger yet.", 409);
  }
  const address = requireProvenWallet(session);

  let check: Awaited<ReturnType<OwnerVerifier["verifyOwner"]>>;
  try {
    check = await ledger.verifyOwner(ticket.nftokenId, address);
  } catch (error) {
    const mapped = toLedgerAppError(error);
    if (mapped instanceof AppError) throw mapped;
    throw ledgerUnavailable();
  }
  if (!check.provenance.validated) throw ledgerUnavailable();
  if (!check.owns) {
    throw new AppError(
      AuthErrorCode.NOT_TICKET_OWNER,
      "Your connected wallet doesn't hold this ticket on the ledger.",
      403,
    );
  }
  return {
    ticketId: ticket.id,
    eventId: ticket.eventId,
    nftokenId: ticket.nftokenId,
    ownerAddress: address,
    ledgerIndex: check.provenance.ledgerIndex,
  };
}

const ledgerUnavailable = () =>
  new AppError(
    ErrorCode.LEDGER_UNAVAILABLE,
    "Couldn't confirm ticket ownership on the XRP Ledger. Try again shortly.",
    503,
    { retryable: true },
  );
