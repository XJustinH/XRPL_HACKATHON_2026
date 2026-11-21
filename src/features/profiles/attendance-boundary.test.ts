import { describe, expect, it } from "vitest";
import type { TicketView } from "@/contracts";
import { listAttendedEvents } from "@/features/checkin/attendance-history";
import { summariseUpcoming } from "./activity-summary";

/**
 * The boundary between *holding* a ticket and *having attended* (XRPL-063).
 *
 * The third acceptance criterion — "a transferred-away unused ticket is not
 * treated as attended" — holds by construction today, because upcoming comes
 * from ledger-verified holdings and attendance comes only from CheckInRecord.
 * Nothing asserted it, though, so a future change that derived attendance from
 * ticket rows would satisfy every existing test while breaking the rule.
 *
 * These run against stubs rather than a database, so they execute in CI without
 * Docker, unlike `attendance-history.int.test.ts`.
 */

const WALLET_A = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const WALLET_B = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

type WalletRow = { address: string; userId: string; verifiedAt: Date | null; revokedAt: Date | null };
type RecordRow = { walletAddress: string; scannedAt: Date; event: EventRow };
type EventRow = { id: string; title: string; startsAt: Date; venue: string; city: string };

const EVENT: EventRow = {
  id: "evt-1",
  title: "Night Market Live",
  startsAt: new Date("2026-12-01T20:00:00.000Z"),
  venue: "Vicar Street",
  city: "Dublin",
};

function stubDb(wallets: WalletRow[], records: RecordRow[]) {
  return {
    walletLink: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        wallets.filter(
          (w) => w.userId === where.userId && w.verifiedAt !== null && w.revokedAt === null,
        ),
    },
    checkInRecord: {
      findMany: async ({ where }: { where: { walletAddress: { in: string[] } } }) =>
        records.filter((r) => where.walletAddress.in.includes(r.walletAddress)),
    },
  } as never;
}

function ticket(overrides: Partial<TicketView> = {}): TicketView {
  return {
    id: "tkt-1",
    eventId: EVENT.id,
    tierId: "tier-1",
    serial: 1,
    tierName: "GA",
    priceDrops: "25000000",
    event: {
      id: EVENT.id,
      title: EVENT.title,
      startsAt: "2099-12-01T20:00:00.000Z",
      venue: EVENT.venue,
      city: EVENT.city,
      artworkUrl: null,
      sellerDisplayName: "Night Market",
    },
    ledger: {
      nftokenId: "A".repeat(64),
      issuerAddress: WALLET_A,
      ownerAddress: WALLET_A,
      mintTxHash: "B".repeat(64),
      lastTransferTxHash: null,
      metadataUri: "https://example.com/t/1",
      ledgerIndex: 1,
      verifiedAt: "2026-11-20T12:00:00.000Z",
      explorerTxUrl: "https://testnet.xrpl.org/transactions/B",
      explorerNftUrl: "https://testnet.xrpl.org/nft/A",
    },
    checkedInAt: null,
    ownedByViewer: true,
    ...overrides,
  };
}

const verified = (address: string, userId: string): WalletRow => ({
  address,
  userId,
  verifiedAt: new Date("2026-11-01T00:00:00.000Z"),
  revokedAt: null,
});

describe("a transferred-away unused ticket is not treated as attended", () => {
  it("does not appear in upcoming, because upcoming comes from current holdings", async () => {
    /*
     * After a transfer, `listTicketsForOwner` no longer returns the ticket, so
     * the summary is given nothing. The point is that upcoming is derived from
     * what the ledger says the wallet holds, not from ticket rows.
     */
    expect(summariseUpcoming([])).toEqual([]);
  });

  it("does not appear in attended, because there is no check-in record", async () => {
    const db = stubDb([verified(WALLET_A, "usr-1")], []);
    expect(await listAttendedEvents(db, "usr-1")).toEqual([]);
  });

  it("does not become attended when the new holder checks in with it", async () => {
    // The ticket moved to WALLET_B, who was admitted. The original holder must
    // not inherit that attendance.
    const db = stubDb(
      [verified(WALLET_A, "usr-1"), verified(WALLET_B, "usr-2")],
      [{ walletAddress: WALLET_B, scannedAt: new Date("2026-12-01T19:30:00.000Z"), event: EVENT }],
    );

    expect(await listAttendedEvents(db, "usr-1")).toEqual([]);
    expect((await listAttendedEvents(db, "usr-2")).map((e) => e.eventId)).toEqual([EVENT.id]);
  });
});

describe("attendance comes only from a recorded check-in", () => {
  it("is empty for a user with a verified wallet but no admissions", async () => {
    const db = stubDb([verified(WALLET_A, "usr-1")], []);
    expect(await listAttendedEvents(db, "usr-1")).toEqual([]);
  });

  it("is empty for a user with no verified wallet, even if a record exists", async () => {
    // An unverified link proves nothing, so it cannot claim an admission.
    const db = stubDb(
      [{ address: WALLET_A, userId: "usr-1", verifiedAt: null, revokedAt: null }],
      [{ walletAddress: WALLET_A, scannedAt: new Date(), event: EVENT }],
    );
    expect(await listAttendedEvents(db, "usr-1")).toEqual([]);
  });

  it("is empty once the wallet link is revoked", async () => {
    const db = stubDb(
      [
        {
          address: WALLET_A,
          userId: "usr-1",
          verifiedAt: new Date("2026-11-01T00:00:00.000Z"),
          revokedAt: new Date("2026-11-15T00:00:00.000Z"),
        },
      ],
      [{ walletAddress: WALLET_A, scannedAt: new Date(), event: EVENT }],
    );
    expect(await listAttendedEvents(db, "usr-1")).toEqual([]);
  });

  it("records an attendance once, however many tickets were used", async () => {
    const db = stubDb(
      [verified(WALLET_A, "usr-1")],
      [
        { walletAddress: WALLET_A, scannedAt: new Date("2026-12-01T19:30:00.000Z"), event: EVENT },
        { walletAddress: WALLET_A, scannedAt: new Date("2026-12-01T19:45:00.000Z"), event: EVENT },
      ],
    );
    const attended = await listAttendedEvents(db, "usr-1");
    expect(attended).toHaveLength(1);
    // The first admission is the one kept.
    expect(attended[0]!.checkedInAt).toBe("2026-12-01T19:30:00.000Z");
  });
});

describe("upcoming comes from owned tickets and dates", () => {
  it("includes a held ticket for a future event", () => {
    expect(summariseUpcoming([ticket()]).map((e) => e.eventId)).toEqual([EVENT.id]);
  });

  it("excludes a held ticket for an event that has passed", () => {
    const past = ticket({ event: { ...ticket().event, startsAt: "2020-01-01T20:00:00.000Z" } });
    expect(summariseUpcoming([past])).toEqual([]);
  });

  it("counts several tickets for one event as a single upcoming entry", () => {
    const summary = summariseUpcoming([ticket({ id: "t1" }), ticket({ id: "t2", serial: 2 })]);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.tickets).toBe(2);
  });

  it("is unaffected by whether a ticket was checked in", () => {
    // Attendance lives in CheckInRecord; a used ticket for a future event is
    // still something the wallet holds.
    const used = ticket({ checkedInAt: "2026-11-20T12:00:00.000Z" });
    expect(summariseUpcoming([used])).toHaveLength(1);
  });
});
