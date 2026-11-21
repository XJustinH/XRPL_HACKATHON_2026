// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AppId, Drops, EventStatus, UserRole } from "@/contracts";
import { DEMO_IDS, DEMO_NOTICE, demoEvents, demoTiers, demoUsers } from "../../scripts/seed/fixtures";

/** Static checks on the XRPL-008 demo fixtures (no database needed). */

const registryIds = Object.values(DEMO_IDS).flatMap((group) => Object.values(group));
const fixtureIds = [...demoUsers, ...demoEvents, ...demoTiers].map((r) => r.id);

describe("demo seed fixtures", () => {
  it("uses unique, valid UUIDs that are all listed in DEMO_IDS", () => {
    for (const id of fixtureIds) expect(AppId.safeParse(id).success, id).toBe(true);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect([...fixtureIds].sort()).toEqual([...registryIds].sort());
  });

  it("covers the issue scope: a seller, a customer, and a published event with a tier", () => {
    expect(demoUsers.some((u) => u.role === "SELLER")).toBe(true);
    expect(demoUsers.some((u) => u.role === "CUSTOMER")).toBe(true);
    const published = demoEvents.filter((e) => e.status === "PUBLISHED");
    expect(published.length).toBeGreaterThan(0);
    expect(published.some((e) => demoTiers.some((t) => t.eventId === e.id))).toBe(true);
  });

  // Titles and display names are deliberately unlabelled: they are what the audience reads during
  // the demo. The content is still identifiable as seeded, by `isDemo`, the fixed `5eed0000-` IDs,
  // and the notices below.
  it("marks every user, event and tier as demo content", () => {
    for (const u of demoUsers) expect(u.isDemo, u.displayName).toBe(true);
    for (const e of demoEvents) {
      expect(e.description.startsWith(DEMO_NOTICE), e.title).toBe(true);
      expect(e.venue, e.title).toMatch(/\(demo venue\)$/);
    }
    for (const t of demoTiers) expect(t.description, t.name).toMatch(/^Demo tier/);
  });

  it("uses roles and statuses that exist in the shared contracts", () => {
    for (const u of demoUsers) expect(UserRole.safeParse(u.role).success, u.role).toBe(true);
    for (const e of demoEvents) expect(EventStatus.safeParse(e.status).success, e.status).toBe(true);
  });

  it("links events to seller accounts and tiers to seeded events", () => {
    const sellers = new Set(demoUsers.filter((u) => u.role === "SELLER").map((u) => u.id));
    const events = new Set<string>(demoEvents.map((e) => e.id));
    for (const e of demoEvents) expect(sellers.has(e.sellerId), e.title).toBe(true);
    for (const t of demoTiers) expect(events.has(t.eventId), t.name).toBe(true);
  });

  it("prices tiers in integer drops with positive supply and unique names per event", () => {
    for (const t of demoTiers) {
      expect(Drops.safeParse(t.priceDrops).success, t.priceDrops).toBe(true);
      expect(Number.isInteger(t.totalSupply) && t.totalSupply > 0, t.name).toBe(true);
    }
    const keys = demoTiers.map((t) => `${t.eventId}/${t.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps publication state and dates consistent", () => {
    for (const e of demoEvents) {
      expect(e.endsAt.getTime(), e.title).toBeGreaterThan(e.startsAt.getTime());
      if (e.status === "PUBLISHED") {
        expect(e.publishedAt, e.title).toBeInstanceOf(Date);
        expect(e.startsAt.getTime(), e.title).toBeGreaterThan(e.publishedAt.getTime());
      } else {
        expect(e.publishedAt, e.title).toBeNull();
      }
    }
  });

  it("contains no wallet addresses or ledger identifiers", () => {
    // Wallets, NFTs, offers and tx hashes must come from live Testnet activity, never fixtures.
    const text = JSON.stringify([demoUsers, demoEvents, demoTiers]);
    expect(text).not.toMatch(/\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/);
    expect(text).not.toMatch(/\b[0-9A-Fa-f]{64}\b/);
  });
});
