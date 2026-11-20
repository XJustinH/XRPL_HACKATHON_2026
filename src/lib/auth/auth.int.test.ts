import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as personasGET } from "@/app/api/auth/demo-personas/route";
import { POST as demoSessionPOST } from "@/app/api/auth/demo-session/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { GET as meGET, PATCH as mePATCH } from "@/app/api/me/route";
import { POST as onboardingPOST } from "@/app/api/onboarding/route";
import { primaryNav, visibleNavItems } from "@/components/nav-config";
import { getDb } from "@/lib/db/client";
import { resetServerEnvCache } from "@/lib/env";
import { createSession, findSessionByToken, hashSessionToken, toHeaderSession } from "./session";

/**
 * XRPL-010 end-to-end through the real route handlers against Postgres
 * (`npm run test:db`; DATABASE_URL points at the *_test database).
 */

const db = getDb();
const ORIGIN = "http://localhost:3000";
const ctx = {} as never;

type Opts = { method?: string; body?: unknown; cookie?: string | null; origin?: string };
function req(path: string, { method = "GET", body, cookie, origin = ORIGIN }: Opts = {}): Request {
  const headers = new Headers({ origin });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** "name=value" from a Set-Cookie header, for replaying as a Cookie header. */
function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected Set-Cookie");
  return setCookie.split(";")[0]!;
}
const tokenOf = (cookie: string) => decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));

async function onboardNew(displayName: string, role: "CUSTOMER" | "SELLER") {
  const res = await onboardingPOST(req("/api/onboarding", { method: "POST", body: { displayName, role } }), ctx);
  expect(res.status).toBe(201);
  return { res, cookie: cookieOf(res), body: await res.json() };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterEach(() => {
  delete process.env.DEMO_LOGIN_ENABLED;
  resetServerEnvCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/onboarding (new visitor)", () => {
  it("creates a customer profile and a hardened session cookie", async () => {
    const { res, cookie, body } = await onboardNew("  Aoife  ", "CUSTOMER");
    expect(body.data.user).toMatchObject({ displayName: "Aoife", role: "CUSTOMER" });
    expect(body.data.user.onboardedAt).not.toBeNull();

    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^xt_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);

    // Only the SHA-256 of the token is stored.
    const token = tokenOf(cookie);
    const row = await db.session.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.method).toBe("ONBOARDING");
  });

  it("saves the seller role, which the navigation then reflects", async () => {
    const seller = await onboardNew("Vicar St Live", "SELLER");
    const customer = await onboardNew("Aoife", "CUSTOMER");

    const sellerSession = await findSessionByToken(db, tokenOf(seller.cookie));
    const customerSession = await findSessionByToken(db, tokenOf(customer.cookie));
    expect(sellerSession?.role).toBe("SELLER");
    expect(customerSession?.role).toBe("CUSTOMER");

    const hrefs = (s: typeof sellerSession) => visibleNavItems(primaryNav, toHeaderSession(s!)).map((i) => i.href);
    expect(hrefs(sellerSession)).toContain("/seller/events");
    expect(hrefs(customerSession)).not.toContain("/seller/events");
    expect(hrefs(customerSession)).toContain("/tickets");
  });

  it("does not let anyone self-select ORGANISER", async () => {
    const res = await onboardingPOST(
      req("/api/onboarding", { method: "POST", body: { displayName: "Gate staff", role: "ORGANISER" } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(await db.user.count()).toBe(0);
  });

  it.each([
    { why: "name too short", body: { displayName: "A", role: "CUSTOMER" } },
    { why: "control characters", body: { displayName: "Bad\u0000Name", role: "CUSTOMER" } },
    { why: "unknown field", body: { displayName: "Aoife", role: "CUSTOMER", isDemo: true } },
  ])("rejects invalid input: $why", async ({ body }) => {
    const res = await onboardingPOST(req("/api/onboarding", { method: "POST", body }), ctx);
    expect(res.status).toBe(400);
    expect(await db.user.count()).toBe(0);
  });

  it("rejects a cross-origin submission without creating anything", async () => {
    const res = await onboardingPOST(
      req("/api/onboarding", {
        method: "POST",
        body: { displayName: "Aoife", role: "CUSTOMER" },
        origin: "https://evil.example",
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await db.user.count()).toBe(0);
  });
});

describe("POST /api/onboarding (existing session)", () => {
  it("refuses to change the role of an onboarded account", async () => {
    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    const res = await onboardingPOST(
      req("/api/onboarding", { method: "POST", cookie, body: { displayName: "Aoife", role: "SELLER" } }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_ONBOARDED");
    expect((await db.user.findFirstOrThrow()).role).toBe("CUSTOMER");
  });

  it("completes a session whose user has not chosen a role yet (wallet-first accounts)", async () => {
    const user = await db.user.create({ data: { displayName: "rWallet…" } });
    const { token } = await createSession(db, user.id, "ONBOARDING");
    const cookie = `xt_session=${token}`;

    const res = await onboardingPOST(
      req("/api/onboarding", { method: "POST", cookie, body: { displayName: "Niamh", role: "SELLER" } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull(); // keeps the existing session
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated).toMatchObject({ role: "SELLER", displayName: "Niamh" });
    expect(updated.onboardedAt).not.toBeNull();
    expect(await db.user.count()).toBe(1);
  });

  it("lets only one of two concurrent role choices win", async () => {
    const user = await db.user.create({ data: { displayName: "rWallet…" } });
    const { token } = await createSession(db, user.id, "ONBOARDING");
    const cookie = `xt_session=${token}`;
    const submit = (role: "CUSTOMER" | "SELLER") =>
      onboardingPOST(req("/api/onboarding", { method: "POST", cookie, body: { displayName: "Niamh", role } }), ctx);

    const statuses = (await Promise.all([submit("CUSTOMER"), submit("SELLER")])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("GET / PATCH /api/me", () => {
  it("is 401 without a session, and returns the account with one", async () => {
    expect((await meGET(req("/api/me"), ctx)).status).toBe(401);

    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    const res = await meGET(req("/api/me", { cookie }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = await res.json();
    expect(data.user).toMatchObject({ displayName: "Aoife", role: "CUSTOMER" });
    expect(data.wallets).toEqual([]);
    expect(data.session.method).toBe("ONBOARDING");
  });

  it("updates the display name", async () => {
    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    const res = await mePATCH(req("/api/me", { method: "PATCH", cookie, body: { displayName: "Aoife B" } }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.user.displayName).toBe("Aoife B");
  });

  it("rejects role escalation and leaves the role unchanged", async () => {
    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    const res = await mePATCH(
      req("/api/me", { method: "PATCH", cookie, body: { displayName: "Aoife", role: "SELLER" } }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ROLE_CHANGE_FORBIDDEN");
    expect((await db.user.findFirstOrThrow()).role).toBe("CUSTOMER");
  });

  it("rejects unknown fields and empty updates", async () => {
    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    for (const body of [{ isDemo: true }, {}]) {
      const res = await mePATCH(req("/api/me", { method: "PATCH", cookie, body }), ctx);
      expect(res.status).toBe(400);
    }
  });

  it("requires a session to update", async () => {
    const res = await mePATCH(req("/api/me", { method: "PATCH", body: { displayName: "Someone" } }), ctx);
    expect(res.status).toBe(401);
  });
});

describe("sessions", () => {
  it("logout revokes the session server-side and clears the cookie", async () => {
    const { cookie } = await onboardNew("Aoife", "CUSTOMER");
    const res = await logoutPOST(req("/api/auth/logout", { method: "POST", cookie }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^xt_session=;.*Max-Age=0/);
    expect((await db.session.findFirstOrThrow()).revokedAt).not.toBeNull();
    // Replaying the old cookie no longer works.
    expect((await meGET(req("/api/me", { cookie }), ctx)).status).toBe(401);
  });

  it("logout without a session is a harmless no-op", async () => {
    expect((await logoutPOST(req("/api/auth/logout", { method: "POST" }), ctx)).status).toBe(200);
  });

  it("rejects expired, unknown and malformed tokens", async () => {
    const user = await db.user.create({ data: { displayName: "Old", onboardedAt: new Date() } });
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const expired = await createSession(db, user.id, "ONBOARDING", past);

    for (const cookie of [
      `xt_session=${expired.token}`,
      `xt_session=${"A".repeat(43)}`,
      "xt_session=not-a-token",
      "xt_session=%E0%A4%A",
    ]) {
      expect((await meGET(req("/api/me", { cookie }), ctx)).status).toBe(401);
    }
  });
});

describe("demo personas", () => {
  async function seedPersonas() {
    const seller = await db.user.create({
      data: { displayName: "Demo Venue", role: "SELLER", isDemo: true, onboardedAt: new Date() },
    });
    const fan = await db.user.create({
      data: { displayName: "Demo Fan", role: "CUSTOMER", isDemo: true, onboardedAt: new Date() },
    });
    const real = await db.user.create({ data: { displayName: "Real Person", onboardedAt: new Date() } });
    return { seller, fan, real };
  }

  it("lists only demo accounts", async () => {
    await seedPersonas();
    const { data } = await (await personasGET(req("/api/auth/demo-personas"), ctx)).json();
    expect(data.enabled).toBe(true);
    expect(data.personas.map((p: { displayName: string }) => p.displayName).sort()).toEqual([
      "Demo Fan",
      "Demo Venue",
    ]);
  });

  it("signs in as a persona and replaces the current session", async () => {
    const { seller } = await seedPersonas();
    const { cookie: oldCookie } = await onboardNew("Aoife", "CUSTOMER");

    const res = await demoSessionPOST(
      req("/api/auth/demo-session", { method: "POST", cookie: oldCookie, body: { userId: seller.id } }),
      ctx,
    );
    expect(res.status).toBe(200);
    const session = await findSessionByToken(db, tokenOf(cookieOf(res)));
    expect(session).toMatchObject({ userId: seller.id, role: "SELLER", method: "DEMO_PERSONA", isDemo: true });
    expect((await meGET(req("/api/me", { cookie: oldCookie }), ctx)).status).toBe(401);
  });

  it("never lets a real account be assumed", async () => {
    const { real } = await seedPersonas();
    const res = await demoSessionPOST(req("/api/auth/demo-session", { method: "POST", body: { userId: real.id } }), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is fully off when DEMO_LOGIN_ENABLED=false", async () => {
    const { fan } = await seedPersonas();
    process.env.DEMO_LOGIN_ENABLED = "false";
    resetServerEnvCache();

    const list = await (await personasGET(req("/api/auth/demo-personas"), ctx)).json();
    expect(list.data).toEqual({ enabled: false, personas: [] });
    const res = await demoSessionPOST(req("/api/auth/demo-session", { method: "POST", body: { userId: fan.id } }), ctx);
    expect(res.status).toBe(404);
  });
});
