// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventAvailability, ResaleListing } from "@/contracts/events";
import { FakeClock } from "@/features/checkin/testing/fakes";
import { ResalePolicy } from "./resale-policy";
import { guardrailsFromEnv } from "./server";

const EVENT = "11111111-1111-4111-8111-111111111111";

let eventRow: { status: "PUBLISHED" | "DRAFT" } | null = { status: "PUBLISHED" };
let session: { userId: string } | null = null;
let owner = false;
let policy: ResalePolicy;

vi.mock("@/lib/db/client", () => ({ getDb: () => ({ event: { findUnique: async () => eventRow } }) }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: async () => session }));
vi.mock("@/lib/auth/permissions", () => ({ isEventOwner: async () => owner }));
vi.mock("@/lib/resale-policy/server", async (orig) => ({
  ...(await orig<typeof import("./server")>()),
  getResalePolicy: () => policy,
}));

const { GET: eligibilityGET } = await import("@/app/api/events/[id]/resale-eligibility/route");
const { GET: offersGET } = await import("@/app/api/events/[id]/resale-offers/route");

const availability = (remaining: number): EventAvailability => ({
  eventId: EVENT,
  totalSupply: 2,
  sold: 2 - remaining,
  remaining,
  isSoldOut: remaining === 0,
  fromPriceDrops: null,
  calculatedAt: "2026-12-01T00:00:00.000Z",
});
const listing = { offerId: "o1", kind: "RESALE", state: "ACTIVE", amountDrops: "3000000", event: { id: EVENT }, ticket: { faceValueDrops: "2500000" } } as unknown as ResaleListing;

function build(remaining: number, maxMarkupPercent?: number) {
  policy = new ResalePolicy({
    clock: new FakeClock(new Date("2026-12-01T12:00:00Z").getTime()),
    events: { getEvent: async () => ({ id: EVENT, status: "PUBLISHED", startsAt: "2026-12-05T20:00:00.000Z" }) },
    inventory: { getAvailability: async () => availability(remaining) },
    offers: { listResaleOffers: async () => [listing] },
    guardrails: maxMarkupPercent === undefined ? {} : { maxMarkupPercent },
  });
}

const call = (handler: typeof eligibilityGET, id = EVENT) =>
  handler(new Request(`http://localhost/api/events/${id}/x`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  eventRow = { status: "PUBLISHED" };
  session = null;
  owner = false;
  build(0);
});

describe("GET /api/events/:id/resale-eligibility", () => {
  it("reports eligibility with the app-only wording and no price cap by default", async () => {
    const res = await call(eligibilityGET);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = await res.json();
    expect(data).toMatchObject({ eventId: EVENT, isPublicResaleAllowed: true, reasonCode: "PRIMARY_SOLD_OUT", priceCapNotice: null });
    expect(data.message).toMatch(/outside this app/);
  });

  it("is closed while primary tickets remain", async () => {
    build(1);
    const { data } = await (await call(eligibilityGET)).json();
    expect(data).toMatchObject({ isPublicResaleAllowed: false, reasonCode: "PRIMARY_STILL_ON_SALE" });
  });

  it("hides drafts from everyone but their owner, and unknown or malformed ids", async () => {
    eventRow = { status: "DRAFT" };
    expect((await call(eligibilityGET)).status).toBe(404);
    session = { userId: "u" };
    expect((await call(eligibilityGET)).status).toBe(404);
    owner = true;
    expect((await call(eligibilityGET)).status).toBe(200);
    eventRow = null;
    expect((await call(eligibilityGET)).status).toBe(404);
    expect((await call(eligibilityGET, "nope")).status).toBe(404);
  });
});

describe("GET /api/events/:id/resale-offers", () => {
  it("lists offers once sold out, with the limitation notice", async () => {
    const { data } = await (await call(offersGET)).json();
    expect(data.offers.map((o: ResaleListing) => o.offerId)).toEqual(["o1"]);
    expect(data.limitationNotice).toMatch(/outside this app/);
    expect(data.eligibility.isPublicResaleAllowed).toBe(true);
  });

  it("returns no offers before sell-out", async () => {
    build(1);
    const { data } = await (await call(offersGET)).json();
    expect(data.offers).toEqual([]);
  });

  it("applies the optional price cap and says so", async () => {
    build(0, 10); // face 2.5 XRP + 10% = 2.75 XRP; listing is 3 XRP
    const { data } = await (await call(offersGET)).json();
    expect(data.offers).toEqual([]);
    expect(data.priceCapNotice).toMatch(/10% above face value/);
  });
});

describe("guardrailsFromEnv", () => {
  const env = (v?: string) => ({ RESALE_MAX_MARKUP_PERCENT: v }) as unknown as NodeJS.ProcessEnv;
  it("is off when unset or blank", () => {
    expect(guardrailsFromEnv(env())).toEqual({});
    expect(guardrailsFromEnv(env("  "))).toEqual({});
  });
  it("reads a whole-number percentage", () => {
    expect(guardrailsFromEnv(env("10"))).toEqual({ maxMarkupPercent: 10 });
  });
  it("rejects anything else", () => {
    for (const bad of ["-5", "2.5", "ten"]) expect(() => guardrailsFromEnv(env(bad))).toThrow();
  });
});
