// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckInService } from "@/features/checkin/checkin-service";
import {
  FakeClock,
  FakeLedger,
  FakeOrganisers,
  FakeProofs,
  FakeTickets,
  InMemoryCheckInStore,
} from "@/features/checkin/testing/fakes";

type TestSession = { userId: string; walletAddress: string | null } | null;
let session: TestSession = null;
let service: CheckInService;

vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    requireSession: async () => {
      if (!session) throw errors.unauthenticated();
      return { ...session, displayName: "x", role: "CUSTOMER" };
    },
  };
});
vi.mock("@/features/checkin/server", () => ({ getCheckInService: () => service }));

const { POST: issue } = await import("./challenges/route");
const { POST: prove } = await import("./challenges/[id]/prove/route");
const { POST: verify } = await import("./verify/route");
const { POST: confirm } = await import("./confirm/route");

const EVENT = "11111111-1111-4111-8111-111111111111";
const TICKET = "33333333-3333-4333-8333-333333333333";
const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA2000000D1";
const ALICE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ORGANISER = "44444444-4444-4444-8444-444444444444";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let ledger: FakeLedger;

beforeEach(() => {
  const tickets = new FakeTickets();
  tickets.add({ ticketId: TICKET, eventId: EVENT, nftokenId: NFT });
  const organisers = new FakeOrganisers();
  organisers.grant(ORGANISER, EVENT);
  ledger = new FakeLedger();
  ledger.owners.set(NFT, ALICE);
  service = new CheckInService(
    { tickets, organisers, ledger, proofs: new FakeProofs(), store: new InMemoryCheckInStore(), clock: new FakeClock() },
    { qrSecret: "route-test-secret-at-least-32-bytes!!" },
  );
  session = { userId: "attendee", walletAddress: ALICE };
});

async function issueAndProve() {
  const res = await issue(post("/api/checkin/challenges", { ticketId: TICKET }), {});
  expect(res.status).toBe(201);
  const { data } = await res.json();
  const proved = await prove(
    post(`/api/checkin/challenges/${data.challengeId}/prove`, { proof: FakeProofs.sign(ALICE, data.messageToSign) }),
    params(data.challengeId),
  );
  expect(proved.status).toBe(200);
  return data as { challengeId: string; qrPayload: string };
}

describe("check-in routes", () => {
  it("full flow: issue, prove, verify, confirm once", async () => {
    const { qrPayload } = await issueAndProve();
    session = { userId: ORGANISER, walletAddress: null };

    const v = await verify(post("/api/checkin/verify", { qrPayload, eventId: EVENT }), {});
    expect(v.status).toBe(200);
    expect((await v.json()).data).toMatchObject({ status: "VERIFIED", ticketId: TICKET, ownerAddress: ALICE });

    const c1 = await confirm(post("/api/checkin/confirm", { qrPayload, eventId: EVENT }), {});
    expect(c1.status).toBe(201);
    expect((await c1.json()).data).toMatchObject({ status: "ADMITTED", ticketId: TICKET });

    const c2 = await confirm(post("/api/checkin/confirm", { qrPayload, eventId: EVENT }), {});
    expect(c2.status).toBe(409);
    expect((await c2.json()).error.code).toBe("ALREADY_USED");
  });

  it("requires a signed-in user", async () => {
    session = null;
    const res = await issue(post("/api/checkin/challenges", { ticketId: TICKET }), {});
    expect(res.status).toBe(401);
  });

  it("needs a wallet: the session's verified one or one named in the body", async () => {
    session = { userId: "attendee", walletAddress: null };
    const none = await issue(post("/api/checkin/challenges", { ticketId: TICKET }), {});
    expect(none.status).toBe(403);
    expect((await none.json()).error.code).toBe("WALLET_NOT_VERIFIED");

    const named = await issue(post("/api/checkin/challenges", { ticketId: TICKET, walletAddress: ALICE }), {});
    expect(named.status).toBe(201);

    const notHolder = await issue(
      post("/api/checkin/challenges", { ticketId: TICKET, walletAddress: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" }),
      {},
    );
    expect(notHolder.status).toBe(403);
    expect((await notHolder.json()).error.code).toBe("WRONG_OWNER");
  });

  it("prefers the session's verified wallet over one named in the body", async () => {
    const res = await issue(
      post("/api/checkin/challenges", { ticketId: TICKET, walletAddress: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" }),
      {},
    );
    expect(res.status).toBe(201);
  });

  it("rejects a malformed wallet address", async () => {
    const res = await issue(post("/api/checkin/challenges", { ticketId: TICKET, walletAddress: "not-an-address" }), {});
    expect(res.status).toBe(400);
  });

  it("validates request bodies and ids", async () => {
    expect((await issue(post("/api/checkin/challenges", { ticketId: "nope" }), {})).status).toBe(400);
    expect((await issue(post("/api/checkin/challenges", "{bad json"), {})).status).toBe(400);
    expect((await prove(post("/api/checkin/challenges/x/prove", { proof: "p" }), params("x"))).status).toBe(400);
  });

  it("maps failures to their HTTP status and code", async () => {
    const { qrPayload } = await issueAndProve();

    session = { userId: "someone-else", walletAddress: null };
    const notOrganiser = await verify(post("/api/checkin/verify", { qrPayload, eventId: EVENT }), {});
    expect(notOrganiser.status).toBe(403);
    expect((await notOrganiser.json()).error.code).toBe("NOT_AUTHORISED");

    session = { userId: ORGANISER, walletAddress: null };
    const bad = await verify(post("/api/checkin/verify", { qrPayload: "xtc1.garbage", eventId: EVENT }), {});
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_QR");

    ledger.down = true;
    const down = await confirm(post("/api/checkin/confirm", { qrPayload, eventId: EVENT }), {});
    expect(down.status).toBe(503);
    expect((await down.json()).error.code).toBe("LEDGER_UNAVAILABLE");
  });

  it("rejects a QR that was never approved in the wallet", async () => {
    const res = await issue(post("/api/checkin/challenges", { ticketId: TICKET }), {});
    const { data } = await res.json();
    session = { userId: ORGANISER, walletAddress: null };
    const v = await verify(post("/api/checkin/verify", { qrPayload: data.qrPayload, eventId: EVENT }), {});
    expect(v.status).toBe(409);
    expect((await v.json()).error.code).toBe("PROOF_REQUIRED");
  });

  it("rejects cross-site requests (CSRF)", async () => {
    const req = new Request("http://localhost/api/checkin/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ qrPayload: "x", eventId: EVENT }),
    });
    expect((await confirm(req, {})).status).toBe(403);
  });
});
