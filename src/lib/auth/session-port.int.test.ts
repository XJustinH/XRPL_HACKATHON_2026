import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for Next's request cookie store.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const { sessionPort } = await import("./session-port");
const { getDb } = await import("@/lib/db/client");
const { resetServerEnvCache } = await import("@/lib/env");

const db = getDb();

beforeEach(async () => {
  jar.clear();
  delete process.env.DEMO_LOGIN_ENABLED;
  resetServerEnvCache();
  await db.$executeRawUnsafe(`TRUNCATE "Session","WalletLink","User" CASCADE`);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("sessionPort (implements the UI SessionPort)", () => {
  it("lists demo personas, switches into one, and signs out", async () => {
    const venue = await db.user.create({
      data: { displayName: "Demo Venue", role: "SELLER", isDemo: true, onboardedAt: new Date() },
    });
    await db.user.create({ data: { displayName: "Real Person", onboardedAt: new Date() } });

    const personas = await sessionPort.listPersonas();
    expect(personas).toEqual([
      { userId: venue.id, displayName: "Demo Venue", role: "SELLER", walletAddress: null },
    ]);

    expect(await sessionPort.getSession()).toBeNull();
    const switched = await sessionPort.setSession(venue.id);
    expect(switched).toEqual({ userId: venue.id, displayName: "Demo Venue", role: "SELLER", walletAddress: null });
    expect(jar.get("xt_session")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(await sessionPort.setSession(null)).toBeNull();
    expect(jar.has("xt_session")).toBe(false);
    expect(await db.session.count({ where: { revokedAt: null } })).toBe(0);
  });

  it("refuses to switch into a real account", async () => {
    const real = await db.user.create({ data: { displayName: "Real Person", onboardedAt: new Date() } });
    await expect(sessionPort.setSession(real.id)).rejects.toMatchObject({ status: 404 });
    expect(jar.size).toBe(0);
  });

  it("offers no personas when demo login is disabled", async () => {
    await db.user.create({ data: { displayName: "Demo Fan", isDemo: true, onboardedAt: new Date() } });
    process.env.DEMO_LOGIN_ENABLED = "false";
    resetServerEnvCache();
    expect(await sessionPort.listPersonas()).toEqual([]);
  });
});
