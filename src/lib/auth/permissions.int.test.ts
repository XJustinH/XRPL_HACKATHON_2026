import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as checkinsGET } from "@/app/api/organisers/events/[id]/checkins/route";
import { GET as metricsGET } from "@/app/api/organisers/events/[id]/metrics/route";
import type { UserRole } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { requireEventOwner, requireRole, requireTicketOwner, type OwnerVerifier } from "./permissions";
import { createSession, findSessionByToken, sessionCookieName } from "./session";

/**
 * XRPL-013 against Postgres: the API refuses unauthorised callers on its own, whatever the
 * UI shows. Requests go straight to the route handlers, as a script or curl would.
 */

const db = getDb();
const ORIGIN = "http://localhost:3000";
const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA200000001";
const HOLDER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ATTACKER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

async function account(role: UserRole, opts: { onboarded?: boolean; wallet?: string } = {}) {
  const user = await db.user.create({
    data: { displayName: `${role} user`, role, onboardedAt: opts.onboarded === false ? null : new Date() },
  });
  const { token } = await createSession(
    db,
    user.id,
    opts.wallet ? "WALLET" : "ONBOARDING",
    new Date(),
    opts.wallet ? { address: opts.wallet } : undefined,
  );
  return { user, token, cookie: `${sessionCookieName()}=${token}`, session: (await findSessionByToken(db, token))! };
}

async function eventOwnedBy(sellerId: string) {
  const event = await db.event.create({
    data: { sellerId, title: "Gig", startsAt: new Date("2027-01-01T20:00:00Z"), venue: "V", city: "Dublin" },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "1000000", totalSupply: 2 } });
  return { event, tier };
}

const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("organiser APIs: only the event's owner", () => {
  const routes = [
    ["GET /api/organisers/events/:id/metrics", metricsGET],
    ["GET /api/organisers/events/:id/checkins", checkinsGET],
  ] as const;

  it.each(routes)("%s answers the owner (SELLER or ORGANISER)", async (_name, handler) => {
    for (const role of ["SELLER", "ORGANISER"] as const) {
      const owner = await account(role);
      const { event } = await eventOwnedBy(owner.user.id);
      const res = await handler(get(`/x/${event.id}`, owner.cookie), ctx(event.id));
      expect(res.status).toBe(200);
    }
  });

  it.each(routes)("%s refuses everyone else, straight from the API", async (_name, handler) => {
    const owner = await account("SELLER");
    const { event } = await eventOwnedBy(owner.user.id);
    const otherSeller = await account("SELLER");
    const customer = await account("CUSTOMER");

    expect((await handler(get(`/x/${event.id}`), ctx(event.id))).status).toBe(401);
    expect((await handler(get(`/x/${event.id}`, otherSeller.cookie), ctx(event.id))).status).toBe(403);
    expect((await handler(get(`/x/${event.id}`, customer.cookie), ctx(event.id))).status).toBe(403);
  });

  it("stops treating a seller as owner if their account is no longer an event manager", async () => {
    const owner = await account("SELLER");
    const { event } = await eventOwnedBy(owner.user.id);
    await db.user.update({ where: { id: owner.user.id }, data: { role: "CUSTOMER" } });
    expect((await metricsGET(get(`/x/${event.id}`, owner.cookie), ctx(event.id))).status).toBe(403);
  });
});

describe("requireEventOwner (event and inventory writes)", () => {
  it("404 unknown event, 403 someone else's, passes for the owner", async () => {
    const owner = await account("SELLER");
    const other = await account("SELLER");
    const { event } = await eventOwnedBy(owner.user.id);

    await expect(requireEventOwner(db, owner.session, "99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({
      status: 404,
    });
    await expect(requireEventOwner(db, other.session, event.id)).rejects.toMatchObject({ code: "NOT_EVENT_OWNER" });
    await expect(requireEventOwner(db, owner.session, event.id)).resolves.toMatchObject({ id: event.id });
  });
});

describe("requireRole (seller-only actions)", () => {
  it("a wallet-first account must choose a role first; customers can't act as sellers", async () => {
    const fresh = await account("CUSTOMER", { onboarded: false, wallet: HOLDER });
    const customer = await account("CUSTOMER");
    expect(() => requireRole(fresh.session, ["SELLER", "ORGANISER"])).toThrow(
      expect.objectContaining({ code: "ONBOARDING_REQUIRED" }),
    );
    expect(() => requireRole(customer.session, ["SELLER", "ORGANISER"])).toThrow(
      expect.objectContaining({ code: "ROLE_REQUIRED" }),
    );
  });
});

describe("requireTicketOwner (resale, private and gift offers)", () => {
  /** A ledger where only HOLDER holds NFT. */
  const ledger: OwnerVerifier = {
    async verifyOwner(nftokenId, address) {
      return { owns: nftokenId === NFT && address === HOLDER, provenance: { ledgerIndex: 777, validated: true } };
    },
  };

  async function mintedTicket(cachedOwnerAddress: string) {
    const seller = await account("SELLER");
    const { event, tier } = await eventOwnedBy(seller.user.id);
    return db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial: 1,
        nftokenId: NFT,
        mintStatus: "MINTED",
        mintTxHash: "A".repeat(64),
        mintedAt: new Date(),
        cachedOwnerAddress,
      },
    });
  }

  it("lets the ledger's holder through", async () => {
    const ticket = await mintedTicket(HOLDER);
    const holder = await account("CUSTOMER", { wallet: HOLDER });
    await expect(requireTicketOwner(db, holder.session, ticket.id, ledger)).resolves.toMatchObject({
      ownerAddress: HOLDER,
      ledgerIndex: 777,
    });
  });

  it("refuses someone the app's stale cache wrongly names as owner", async () => {
    const ticket = await mintedTicket(ATTACKER); // cache is stale / wrong
    const attacker = await account("CUSTOMER", { wallet: ATTACKER });
    await expect(requireTicketOwner(db, attacker.session, ticket.id, ledger)).rejects.toMatchObject({
      code: "NOT_TICKET_OWNER",
      status: 403,
    });
  });

  it("refuses a signed-in user without a proven wallet, and unminted tickets", async () => {
    const ticket = await mintedTicket(HOLDER);
    const noWallet = await account("CUSTOMER");
    await expect(requireTicketOwner(db, noWallet.session, ticket.id, ledger)).rejects.toMatchObject({
      code: "WALLET_NOT_VERIFIED",
    });

    const unminted = await db.ticketNFT.create({ data: { eventId: ticket.eventId, tierId: ticket.tierId, serial: 2 } });
    const holder = await account("CUSTOMER", { wallet: HOLDER });
    await expect(requireTicketOwner(db, holder.session, unminted.id, ledger)).rejects.toMatchObject({
      code: "TICKET_NOT_MINTED",
      status: 409,
    });
  });
});
