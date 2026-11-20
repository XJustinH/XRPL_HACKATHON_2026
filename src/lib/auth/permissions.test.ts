// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { XrplServiceError } from "@/lib/xrpl";
import {
  eventAccess,
  isEventOwner,
  requireEventManager,
  requireEventOwner,
  requireProvenWallet,
  requireRole,
  requireTicketOwner,
  type OwnerVerifier,
} from "./permissions";
import type { AuthSession } from "./session";

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA200000001";
const WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    sessionId: "s",
    userId: SELLER_ID,
    displayName: "Venue",
    role: "SELLER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: null,
    walletVerifiedAt: null,
    ...over,
  };
}

const eventDb = (row: { sellerId: string; role: string } | null) =>
  ({
    event: {
      findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        row === null
          ? null
          : "seller" in select
            ? { sellerId: row.sellerId, seller: { role: row.role } }
            : { id: EVENT_ID, sellerId: row.sellerId, status: "PUBLISHED" },
      ),
    },
  }) as never;

const ticketDb = (row: { nftokenId: string | null; cachedOwnerAddress?: string } | null) =>
  ({
    ticketNFT: {
      findUnique: vi.fn(async () => (row === null ? null : { id: TICKET_ID, eventId: EVENT_ID, ...row })),
    },
  }) as never;

const ledger = (impl: OwnerVerifier["verifyOwner"]): OwnerVerifier => ({ verifyOwner: vi.fn(impl) });
const owns = (value: boolean, validated = true) =>
  ledger(async () => ({ owns: value, provenance: { ledgerIndex: 12345, validated } }));

describe("requireRole / requireEventManager", () => {
  it("requires a chosen role", () => {
    expect(() => requireRole(session({ onboardedAt: null }), ["SELLER"])).toThrow(
      expect.objectContaining({ code: "ONBOARDING_REQUIRED", status: 403 }),
    );
  });

  it("rejects customers from seller-only actions", () => {
    expect(() => requireEventManager(session({ role: "CUSTOMER" }))).toThrow(
      expect.objectContaining({ code: "ROLE_REQUIRED", status: 403 }),
    );
  });

  it("allows sellers and organisers to manage events", () => {
    expect(() => requireEventManager(session({ role: "SELLER" }))).not.toThrow();
    expect(() => requireEventManager(session({ role: "ORGANISER" }))).not.toThrow();
  });
});

describe("event ownership", () => {
  it("is the event's own seller while they are an event manager", async () => {
    expect(await isEventOwner(eventDb({ sellerId: SELLER_ID, role: "SELLER" }), SELLER_ID, EVENT_ID)).toBe(true);
    expect(await isEventOwner(eventDb({ sellerId: SELLER_ID, role: "ORGANISER" }), SELLER_ID, EVENT_ID)).toBe(true);
    expect(await isEventOwner(eventDb({ sellerId: SELLER_ID, role: "SELLER" }), OTHER_ID, EVENT_ID)).toBe(false);
    expect(await isEventOwner(eventDb({ sellerId: SELLER_ID, role: "CUSTOMER" }), SELLER_ID, EVENT_ID)).toBe(false);
    expect(await isEventOwner(eventDb(null), SELLER_ID, EVENT_ID)).toBe(false);
  });

  it("requireEventOwner: 404 missing, 403 someone else's, returns the event to its owner", async () => {
    await expect(requireEventOwner(eventDb(null), session(), EVENT_ID)).rejects.toMatchObject({ status: 404 });
    await expect(
      requireEventOwner(eventDb({ sellerId: OTHER_ID, role: "SELLER" }), session(), EVENT_ID),
    ).rejects.toMatchObject({ code: "NOT_EVENT_OWNER", status: 403 });
    await expect(
      requireEventOwner(eventDb({ sellerId: SELLER_ID, role: "SELLER" }), session({ role: "CUSTOMER" }), EVENT_ID),
    ).rejects.toMatchObject({ code: "NOT_EVENT_OWNER" });
    await expect(
      requireEventOwner(eventDb({ sellerId: SELLER_ID, role: "SELLER" }), session(), EVENT_ID),
    ).resolves.toMatchObject({ id: EVENT_ID, sellerId: SELLER_ID });
  });

  it("eventAccess satisfies the check-in OrganiserAccess port", async () => {
    const access = eventAccess(eventDb({ sellerId: SELLER_ID, role: "SELLER" }));
    expect(await access.canScanEvent(SELLER_ID, EVENT_ID)).toBe(true);
    expect(await access.canScanEvent(OTHER_ID, EVENT_ID)).toBe(false);
  });
});

describe("requireProvenWallet", () => {
  it("returns the session's verified wallet, or 403", () => {
    expect(requireProvenWallet(session({ walletAddress: WALLET }))).toBe(WALLET);
    expect(() => requireProvenWallet(session())).toThrow(
      expect.objectContaining({ code: "WALLET_NOT_VERIFIED", status: 403 }),
    );
  });
});

describe("requireTicketOwner", () => {
  const withWallet = session({ role: "CUSTOMER", walletAddress: WALLET });

  it("confirms the holder from a validated ledger", async () => {
    const result = await requireTicketOwner(ticketDb({ nftokenId: NFT }), withWallet, TICKET_ID, owns(true));
    expect(result).toEqual({ ticketId: TICKET_ID, eventId: EVENT_ID, nftokenId: NFT, ownerAddress: WALLET, ledgerIndex: 12345 });
  });

  it("ignores the app's cached owner: the ledger decides", async () => {
    const db = ticketDb({ nftokenId: NFT, cachedOwnerAddress: WALLET });
    await expect(requireTicketOwner(db, withWallet, TICKET_ID, owns(false))).rejects.toMatchObject({
      code: "NOT_TICKET_OWNER",
      status: 403,
    });
  });

  it("404 unknown ticket, 409 unminted ticket, 403 without a proven wallet", async () => {
    const verifier = owns(true);
    await expect(requireTicketOwner(ticketDb(null), withWallet, TICKET_ID, verifier)).rejects.toMatchObject({ status: 404 });
    await expect(requireTicketOwner(ticketDb({ nftokenId: null }), withWallet, TICKET_ID, verifier)).rejects.toMatchObject({
      code: "TICKET_NOT_MINTED",
      status: 409,
    });
    await expect(requireTicketOwner(ticketDb({ nftokenId: NFT }), session(), TICKET_ID, verifier)).rejects.toMatchObject({
      code: "WALLET_NOT_VERIFIED",
    });
    expect(verifier.verifyOwner).not.toHaveBeenCalled();
  });

  it("never treats an unreadable or unvalidated ledger as ownership", async () => {
    const db = ticketDb({ nftokenId: NFT });
    await expect(requireTicketOwner(db, withWallet, TICKET_ID, owns(true, false))).rejects.toMatchObject({
      code: "LEDGER_UNAVAILABLE",
      status: 503,
    });
    const down = ledger(async () => {
      throw new XrplServiceError("NODE_UNAVAILABLE", "no node");
    });
    await expect(requireTicketOwner(db, withWallet, TICKET_ID, down)).rejects.toMatchObject({ status: 503 });
    const weird = ledger(async () => {
      throw new Error("boom");
    });
    await expect(requireTicketOwner(db, withWallet, TICKET_ID, weird)).rejects.toMatchObject({
      code: "LEDGER_UNAVAILABLE",
      status: 503,
    });
  });
});
