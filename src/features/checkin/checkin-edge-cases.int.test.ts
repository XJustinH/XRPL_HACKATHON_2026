import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as provePOST } from "@/app/api/checkin/challenges/[id]/prove/route";
import { POST as issuePOST } from "@/app/api/checkin/challenges/route";
import { POST as confirmPOST } from "@/app/api/checkin/confirm/route";
import { POST as verifyPOST } from "@/app/api/checkin/verify/route";
import { createSession, sessionCookieName } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { CheckInService } from "./checkin-service";
import { EventSellerAccess } from "./organiser-access";
import { PrismaCheckInStore, PrismaTicketDirectory } from "./prisma-store";
import { setCheckInServiceForTests } from "./server";
import { FakeClock, FakeLedger, FakeProofs } from "./testing/fakes";

/**
 * XRPL-049: check-in rejection and ownership edge cases, end to end through the real route
 * handlers, real sessions and the real Prisma store (`npm run test:db`).
 * Only the XRP Ledger and the wallet signature are simulated (FakeLedger / FakeProofs).
 * Every rejection must leave the CheckInRecord table untouched.
 */

const db = getDb();
const ORIGIN = "http://localhost:3000";
const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA2000000E1";
const ALICE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const MALLORY = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const TTL_MS = 60_000;

let ledger: FakeLedger;
let clock: FakeClock;

type Fixture = Awaited<ReturnType<typeof seed>>;

async function userWithSession(displayName: string, role: "CUSTOMER" | "SELLER", wallet?: string) {
  const user = await db.user.create({ data: { displayName, role, onboardedAt: new Date() } });
  if (wallet) {
    await db.walletLink.create({
      data: { userId: user.id, address: wallet, verifiedAt: new Date(), verificationProvider: "test" },
    });
  }
  const { token } = await createSession(db, user.id, "ONBOARDING");
  return { user, cookie: `${sessionCookieName()}=${token}` };
}

async function seed() {
  const organiser = await userWithSession("Venue", "SELLER");
  const otherOrganiser = await userWithSession("Other venue", "SELLER");
  const alice = await userWithSession("Alice", "CUSTOMER", ALICE);
  const mallory = await userWithSession("Mallory", "CUSTOMER", MALLORY);

  const event = await db.event.create({
    data: {
      sellerId: organiser.user.id,
      title: "Gig",
      startsAt: new Date("2026-12-01T20:00:00Z"),
      venue: "Vicar St",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const otherEvent = await db.event.create({
    data: {
      sellerId: otherOrganiser.user.id,
      title: "Other gig",
      startsAt: new Date("2026-12-01T20:00:00Z"),
      venue: "Button Factory",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "1000000", totalSupply: 1 } });
  const ticket = await db.ticketNFT.create({
    data: {
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
      nftokenId: NFT,
      mintStatus: "MINTED",
      mintTxHash: "E".repeat(64),
      mintedAt: new Date(),
    },
  });
  return { organiser, otherOrganiser, alice, mallory, event, otherEvent, ticket };
}

function post(path: string, cookie: string | null, body: unknown, origin = ORIGIN): Request {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(handler: (r: Request, c: never) => Promise<Response>, req: Request, ctx: unknown = {}) {
  const res = await handler(req, ctx as never);
  return { status: res.status, body: await res.json() };
}

/** Attendee requests a code and, unless `approve` is false, approves it in their wallet. */
async function attendeeCode(f: Fixture, { approve = true } = {}) {
  const issued = await call(issuePOST, post("/api/checkin/challenges", f.alice.cookie, { ticketId: f.ticket.id }));
  expect(issued.status).toBe(201);
  const code = issued.body.data as { challengeId: string; qrPayload: string; messageToSign: string };
  if (approve) expect((await prove(f.alice.cookie, code, ALICE)).status).toBe(200);
  return code;
}

function prove(cookie: string, code: { challengeId: string; messageToSign: string }, signer: string) {
  return call(
    provePOST,
    post(`/api/checkin/challenges/${code.challengeId}/prove`, cookie, { proof: FakeProofs.sign(signer, code.messageToSign) }),
    { params: Promise.resolve({ id: code.challengeId }) },
  );
}

const gate = (f: Fixture, qrPayload: string, { as = f.organiser, eventId = f.event.id } = {}) =>
  post("/api/checkin/confirm", as.cookie, { qrPayload, eventId });

const records = () => db.checkInRecord.count();

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
  ledger = new FakeLedger();
  ledger.owners.set(NFT, ALICE);
  clock = new FakeClock(Date.now());
  setCheckInServiceForTests(
    new CheckInService(
      {
        tickets: new PrismaTicketDirectory(db),
        organisers: new EventSellerAccess(db),
        ledger,
        proofs: new FakeProofs(),
        store: new PrismaCheckInStore(db),
        clock,
      },
      { qrSecret: "edge-case-test-secret-at-least-32-bytes", challengeTtlMs: TTL_MS },
    ),
  );
});

afterAll(async () => {
  setCheckInServiceForTests(null);
  await db.$disconnect();
});

describe("XRPL-049 check-in edge cases (Postgres)", () => {
  it("baseline: a valid ticket is admitted exactly once", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    const res = await call(confirmPOST, gate(f, qrPayload));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "ADMITTED", ticketId: f.ticket.id });
    const row = await db.checkInRecord.findFirstOrThrow();
    expect(row).toMatchObject({ ticketId: f.ticket.id, eventId: f.event.id, organiserId: f.organiser.user.id, walletAddress: ALICE });
  });

  it("duplicate scan of the same code is rejected", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    expect((await call(confirmPOST, gate(f, qrPayload))).status).toBe(201);
    const again = await call(confirmPOST, gate(f, qrPayload));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_USED");
    expect(await records()).toBe(1);
  });

  it("a fresh code for an already-used ticket is refused", async () => {
    const f = await seed();
    const first = await attendeeCode(f);
    await call(confirmPOST, gate(f, first.qrPayload));
    const res = await call(issuePOST, post("/api/checkin/challenges", f.alice.cookie, { ticketId: f.ticket.id }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_USED");
    expect(await records()).toBe(1);
  });

  it("concurrent scans of two codes for one ticket admit exactly once", async () => {
    const f = await seed();
    const a = await attendeeCode(f);
    const b = await attendeeCode(f);
    const results = await Promise.all([call(confirmPOST, gate(f, a.qrPayload)), call(confirmPOST, gate(f, b.qrPayload))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await records()).toBe(1);
  });

  it("unrelated wallet cannot get a code for someone else's ticket", async () => {
    const f = await seed();
    const res = await call(issuePOST, post("/api/checkin/challenges", f.mallory.cookie, { ticketId: f.ticket.id }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("WRONG_OWNER");
    expect(await records()).toBe(0);
  });

  it("unrelated wallet cannot approve the holder's code (copied screenshot)", async () => {
    const f = await seed();
    const code = await attendeeCode(f, { approve: false });
    const stolen = await prove(f.mallory.cookie, code, MALLORY);
    expect(stolen.status).toBe(401);
    expect(stolen.body.error.code).toBe("INVALID_PROOF");
    const res = await call(confirmPOST, gate(f, code.qrPayload));
    expect(res.body.error.code).toBe("PROOF_REQUIRED");
    expect(await records()).toBe(0);
  });

  it("a code never approved in the wallet is not admitted", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f, { approve: false });
    const res = await call(confirmPOST, gate(f, qrPayload));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROOF_REQUIRED");
    expect(await records()).toBe(0);
  });

  it("wrong event: another event's organiser scanning at their own gate is refused", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    const res = await call(confirmPOST, gate(f, qrPayload, { as: f.otherOrganiser, eventId: f.otherEvent.id }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("WRONG_EVENT");
    expect(await records()).toBe(0);
  });

  it("someone who is not the event's organiser cannot admit", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    const res = await call(confirmPOST, gate(f, qrPayload, { as: f.otherOrganiser }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_AUTHORISED");
    expect(await records()).toBe(0);
  });

  it("expired code is rejected", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    clock.advance(TTL_MS);
    const res = await call(confirmPOST, gate(f, qrPayload));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("EXPIRED");
    expect(await records()).toBe(0);
  });

  it("ticket transferred to another wallet on XRPL after approval is rejected", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    const preview = await call(verifyPOST, post("/api/checkin/verify", f.organiser.cookie, { qrPayload, eventId: f.event.id }));
    expect(preview.status).toBe(200);

    ledger.owners.set(NFT, MALLORY); // sold or sent outside the app
    const res = await call(confirmPOST, gate(f, qrPayload));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("WRONG_OWNER");
    expect(await records()).toBe(0);
  });

  it("ledger unavailable never admits", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    ledger.down = true;
    const res = await call(confirmPOST, gate(f, qrPayload));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("LEDGER_UNAVAILABLE");
    expect(await records()).toBe(0);
  });

  it("tampered code and cross-site requests are rejected", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    const tampered = qrPayload.slice(0, -1) + (qrPayload.endsWith("A") ? "B" : "A");
    expect((await call(confirmPOST, gate(f, tampered))).body.error.code).toBe("INVALID_QR");
    const csrf = await call(confirmPOST, post("/api/checkin/confirm", f.organiser.cookie, { qrPayload, eventId: f.event.id }, "https://evil.example"));
    expect(csrf.status).toBe(403);
    expect(await records()).toBe(0);
  });

  it("verify is read-only", async () => {
    const f = await seed();
    const { qrPayload } = await attendeeCode(f);
    for (let i = 0; i < 3; i += 1) {
      expect((await call(verifyPOST, post("/api/checkin/verify", f.organiser.cookie, { qrPayload, eventId: f.event.id }))).status).toBe(200);
    }
    expect(await records()).toBe(0);
    expect(await db.checkInChallenge.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });
});
