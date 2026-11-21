import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConfirmedLedgerTx,
  LedgerNftOffer,
  TransactionRequest,
  TransactionRequestStatus,
} from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import { requestHolderOffer, type HolderOfferDeps } from "./holder";
import { reconcileOfferCreation } from "./primary";
import { getOfferStatus, requestPurchase, type PurchaseDeps } from "./purchase";

/**
 * Holder offers (XRPL-036 resale, 040 private sale, 041 gift) and accepting them (XRPL-039..041),
 * against Postgres (`npm run test:db`) with Xaman and the ledger faked.
 */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOLDER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const STRANGER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NFT = nftokenIdFor(ISSUER, 7, 1);
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const hash = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

/** A published event whose one ticket was sold on primary and is now held by HOLDER. */
async function seed(options: { soldOnPrimary?: boolean; startsAt?: Date } = {}) {
  const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
  const holder = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() } });
  const friend = await db.user.create({ data: { displayName: "Friend", role: "CUSTOMER", onboardedAt: new Date() } });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig",
      startsAt: options.startsAt ?? new Date("2027-03-12T20:00:00Z"),
      venue: "Rooms",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 1, mintedQuantity: 1 },
  });
  const soldAt = new Date("2026-11-20T12:00:00Z");
  const ticket = await db.ticketNFT.create({
    data: {
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
      issuerAddress: ISSUER,
      mintStatus: "MINTED",
      nftokenId: NFT,
      mintTxHash: hash(1),
      mintedAt: new Date(),
      primarySoldAt: options.soldOnPrimary === false ? null : soldAt,
      cachedOwnerAddress: HOLDER,
    },
  });
  return { seller, holder, friend, event, tier, ticket, soldAt };
}

function session(userId: string, walletAddress: string | null): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role: "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress,
    walletVerifiedAt: walletAddress ? new Date() : null,
  };
}

function txRequest(status: TransactionRequestStatus, extra: Partial<TransactionRequest> = {}): TransactionRequest {
  return {
    id: randomUUID(),
    purpose: "CREATE_RESALE_OFFER",
    reference: null,
    status,
    transactionType: "NFTokenCreateOffer",
    account: HOLDER,
    instruction: "x",
    signUrl: "https://xumm.app/sign/x",
    qrPngUrl: "https://xumm.app/sign/x_q.png",
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

const provenance = { endpoint: "wss://node", ledgerIndex: 3000, ledgerHash: null, validated: true, fetchedAt: "" };

interface World {
  /** Who holds the NFT on the ledger. */
  holder: string;
  /** Status every wallet request reports. */
  status: TransactionRequestStatus;
  /** The validated transaction `getValidatedTx` returns. */
  confirmed?: Partial<ConfirmedLedgerTx>;
  /** Live sell offers on the ledger. */
  sellOffers: LedgerNftOffer[];
}

function deps(world: World, extra: { resalePolicy?: PurchaseDeps["resalePolicy"]; resalePrice?: HolderOfferDeps["resalePrice"] } = {}) {
  const create = vi.fn(async (input: { purpose: string; reference?: string | null }) =>
    txRequest("PENDING", { purpose: input.purpose as TransactionRequest["purpose"], reference: input.reference ?? null }),
  );
  const get = vi.fn(async (id: string) => ({ ...txRequest(world.status, { txHash: hash(9) }), id }));
  const getValidatedTx = vi.fn(
    async (h: string): Promise<ConfirmedLedgerTx> => ({
      hash: h,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: 3001,
      closeTime: "2026-11-21T10:00:00.000Z",
      transactionType: "NFTokenCreateOffer",
      account: HOLDER,
      nftokenId: NFT,
      offerIndex: OFFER_INDEX,
      acceptedSellOfferIndex: null,
      explorerUrl: `https://testnet.xrpl.org/transactions/${h}`,
      ...world.confirmed,
    }),
  );
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.holder === address,
    nft: null,
    provenance,
  }));
  const getOffers = vi.fn(async (nftokenId: string) => ({ nftokenId, sellOffers: world.sellOffers, buyOffers: [], provenance }));
  const getAccountInfo = vi.fn(async (address: string) => ({
    address,
    exists: true,
    balanceDrops: "100000000",
    sequence: 1,
    ownerCount: 0,
    provenance,
  }));
  const getReserves = vi.fn(async () => ({ baseDrops: "1000000", incrementDrops: "200000" }));
  const all = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers, getAccountInfo, getReserves }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" } as never,
    ...extra,
  };
  return { all: all as HolderOfferDeps & PurchaseDeps, create };
}

const holding = (): World => ({ holder: HOLDER, status: "PENDING", sellOffers: [] });

function ledgerOffer(o: Partial<LedgerNftOffer>): LedgerNftOffer {
  return {
    offerIndex: OFFER_INDEX,
    nftokenId: NFT,
    side: "SELL",
    owner: HOLDER,
    amountDrops: "3000000",
    amountIssued: null,
    destination: null,
    expiresAt: null,
    flags: 1,
    ...o,
  } as LedgerNftOffer;
}

type CreateInput = { purpose: string; instruction: string; txjson: Record<string, unknown> };
const firstCreate = (create: ReturnType<typeof deps>["create"]) =>
  (create.mock.calls[0] as unknown as [CreateInput])[0];

describe("requestHolderOffer", () => {
  it("lists a ticket for public resale at the holder's price", async () => {
    const { holder, ticket } = await seed();
    const { all, create } = deps(holding());

    const { offer } = await requestHolderOffer(all, {
      session: session(holder.id, HOLDER),
      ticketId: ticket.id,
      offer: { kind: "RESALE", amountDrops: "3000000" },
    });

    expect(offer).toMatchObject({ kind: "RESALE", state: "PENDING_SIGNATURE", ownerAddress: HOLDER, amountDrops: "3000000", destinationAddress: null });
    const input = firstCreate(create);
    expect(input.purpose).toBe("CREATE_RESALE_OFFER");
    expect(input.txjson).toMatchObject({ TransactionType: "NFTokenCreateOffer", Account: HOLDER, NFTokenID: NFT, Amount: "3000000", Flags: 1 });
    expect(input.txjson).not.toHaveProperty("Destination");
    expect(await db.ledgerTransaction.findFirstOrThrow()).toMatchObject({ type: "NFTokenCreateOffer", status: "PENDING", relatedOfferId: offer.id });
  });

  it("restricts a private sale to the named wallet", async () => {
    const { holder, ticket } = await seed();
    const { all, create } = deps(holding());

    const { offer } = await requestHolderOffer(all, {
      session: session(holder.id, HOLDER),
      ticketId: ticket.id,
      offer: { kind: "PRIVATE", amountDrops: "2000000", destination: FRIEND },
    });

    expect(offer).toMatchObject({ kind: "PRIVATE", amountDrops: "2000000", destinationAddress: FRIEND });
    const input = firstCreate(create);
    expect(input.purpose).toBe("CREATE_PRIVATE_OFFER");
    expect(input.txjson).toMatchObject({ Amount: "2000000", Destination: FRIEND });
  });

  it("makes a gift a zero-price offer for the named wallet and warns it can't be undone", async () => {
    const { holder, ticket } = await seed();
    const { all, create } = deps(holding());

    const { offer } = await requestHolderOffer(all, {
      session: session(holder.id, HOLDER),
      ticketId: ticket.id,
      offer: { kind: "GIFT", destination: FRIEND },
    });

    expect(offer).toMatchObject({ kind: "GIFT", amountDrops: "0", destinationAddress: FRIEND });
    const input = firstCreate(create);
    expect(input.purpose).toBe("CREATE_GIFT_OFFER");
    expect(input.txjson).toMatchObject({ Amount: "0", Destination: FRIEND });
    expect(input.instruction).toContain("can't be undone");
  });

  it("refuses anyone who can't offer the ticket, without asking the wallet", async () => {
    const { holder, ticket } = await seed();
    const { all, create } = deps(holding());
    const attempt = (who: AuthSession, offer: Parameters<typeof requestHolderOffer>[1]["offer"]) =>
      requestHolderOffer(all, { session: who, ticketId: ticket.id, offer });
    const resale = { kind: "RESALE" as const, amountDrops: "3000000" };

    await expect(attempt(session(holder.id, null), resale)).rejects.toMatchObject({ status: 403, code: "WALLET_NOT_VERIFIED" });
    // Not the wallet holding the NFT on the ledger.
    await expect(attempt(session(holder.id, STRANGER), resale)).rejects.toThrow("doesn't hold this ticket");
    await expect(attempt(session(holder.id, HOLDER), { kind: "GIFT", destination: HOLDER })).rejects.toThrow("your own wallet");
    await expect(attempt(session(holder.id, HOLDER), { kind: "GIFT", destination: "rNotAnAddress111111111111111" })).rejects.toMatchObject({ status: 400 });
    await expect(
      requestHolderOffer(all, { session: session(holder.id, HOLDER), ticketId: randomUUID(), offer: resale }),
    ).rejects.toMatchObject({ status: 404 });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses tickets that aren't sold yet, have been used, or whose event has finished", async () => {
    const unsold = await seed({ soldOnPrimary: false });
    const { all } = deps(holding());
    const resale = { kind: "RESALE" as const, amountDrops: "3000000" };
    await expect(
      requestHolderOffer(all, { session: session(unsold.holder.id, HOLDER), ticketId: unsold.ticket.id, offer: resale }),
    ).rejects.toThrow("hasn't been sold yet");

    await db.ticketNFT.update({ where: { id: unsold.ticket.id }, data: { primarySoldAt: new Date() } });
    await db.checkInRecord.create({
      data: { ticketId: unsold.ticket.id, eventId: unsold.event.id, organiserId: unsold.seller.id, walletAddress: HOLDER },
    });
    await expect(
      requestHolderOffer(all, { session: session(unsold.holder.id, HOLDER), ticketId: unsold.ticket.id, offer: resale }),
    ).rejects.toThrow("already been used");

    await db.checkInRecord.deleteMany();
    await db.event.update({ where: { id: unsold.event.id }, data: { startsAt: new Date("2020-01-01T20:00:00Z") } });
    await expect(
      requestHolderOffer(all, { session: session(unsold.holder.id, HOLDER), ticketId: unsold.ticket.id, offer: resale }),
    ).rejects.toThrow("has finished");
  });

  it("applies the resale price cap before the holder signs", async () => {
    const { holder, ticket } = await seed();
    const { all, create } = deps(holding(), {
      resalePrice: (face, amount) =>
        BigInt(amount) <= BigInt(face) ? { allowed: true } : { allowed: false, message: "Above face value" },
    });
    await expect(
      requestHolderOffer(all, { session: session(holder.id, HOLDER), ticketId: ticket.id, offer: { kind: "RESALE", amountDrops: "9000000" } }),
    ).rejects.toThrow("Above face value");
    expect(create).not.toHaveBeenCalled();
  });

  it("allows one live offer per ticket", async () => {
    const { holder, ticket } = await seed();
    const { all } = deps(holding());
    const who = session(holder.id, HOLDER);
    await requestHolderOffer(all, { session: who, ticketId: ticket.id, offer: { kind: "RESALE", amountDrops: "3000000" } });
    await expect(
      requestHolderOffer(all, { session: who, ticketId: ticket.id, offer: { kind: "GIFT", destination: FRIEND } }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("recording holder offers", () => {
  it("activates a private sale only when the ledger's offer names the same recipient", async () => {
    const { holder, ticket } = await seed();
    const pending = deps({ ...holding(), status: "PENDING" });
    const { offer } = await requestHolderOffer(pending.all, {
      session: session(holder.id, HOLDER),
      ticketId: ticket.id,
      offer: { kind: "PRIVATE", amountDrops: "2000000", destination: FRIEND },
    });

    // The ledger shows the offer without the Destination the app asked for: refuse to activate it.
    const wrong = deps({ ...holding(), status: "CONFIRMED", sellOffers: [ledgerOffer({ amountDrops: "2000000", destination: null })] });
    await expect(reconcileOfferCreation(wrong.all, offer.id)).rejects.toThrow("does not match");
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("PENDING_SIGNATURE");

    const right = deps({ ...holding(), status: "CONFIRMED", sellOffers: [ledgerOffer({ amountDrops: "2000000", destination: FRIEND })] });
    await expect(reconcileOfferCreation(right.all, offer.id)).resolves.toMatchObject({ state: "ACTIVE", offerIndex: OFFER_INDEX });
  });

  it("records a new offer when its status is read", async () => {
    const { holder, ticket } = await seed();
    const { offer } = await requestHolderOffer(deps(holding()).all, {
      session: session(holder.id, HOLDER),
      ticketId: ticket.id,
      offer: { kind: "RESALE", amountDrops: "3000000" },
    });
    const confirmed = deps({ ...holding(), status: "CONFIRMED", sellOffers: [ledgerOffer({})] });
    expect((await getOfferStatus(confirmed.all, offer.id)).offer.state).toBe("ACTIVE");
  });
});

describe("accepting holder offers", () => {
  /** An ACTIVE holder offer of `kind`, as recorded from the ledger. */
  async function activeOffer(kind: "RESALE" | "PRIVATE" | "GIFT") {
    const world = await seed();
    const offer = await db.nFTOffer.create({
      data: {
        ticketId: world.ticket.id,
        nftokenId: NFT,
        kind,
        state: "ACTIVE",
        ownerAddress: HOLDER,
        destinationAddress: kind === "RESALE" ? null : FRIEND,
        amountDrops: kind === "GIFT" ? "0" : "3000000",
        offerIndex: OFFER_INDEX,
        createTxHash: hash(2),
      },
    });
    const live = ledgerOffer({ amountDrops: offer.amountDrops, destination: offer.destinationAddress });
    return { ...world, offer, live };
  }

  it("lets only the named wallet accept a private sale or gift", async () => {
    const { friend, offer, live } = await activeOffer("GIFT");
    const { all, create } = deps({ ...holding(), sellOffers: [live] });

    await expect(requestPurchase(all, { session: session(friend.id, STRANGER), offerId: offer.id })).rejects.toMatchObject({ status: 404 });
    const result = await requestPurchase(all, { session: session(friend.id, FRIEND), offerId: offer.id });
    expect(result.amountDrops).toBe("0");
    const input = firstCreate(create);
    expect(input.purpose).toBe("ACCEPT_TRANSFER_OFFER");
    expect(input.instruction).toContain("Accept ticket gift");
    expect(input.txjson).toMatchObject({ TransactionType: "NFTokenAcceptOffer", Account: FRIEND, NFTokenSellOffer: OFFER_INDEX });
  });

  it("sells a resale ticket only while the in-app resale rule lists it", async () => {
    const { friend, ticket, offer, live } = await activeOffer("RESALE");
    const world = { ...holding(), sellOffers: [live] };
    const buy = (d: ReturnType<typeof deps>["all"]) => requestPurchase(d, { session: session(friend.id, STRANGER), offerId: offer.id });

    // No policy wired in, or the policy doesn't list it: the offer is hidden.
    await expect(buy(deps(world).all)).rejects.toMatchObject({ status: 404 });
    const hidden = vi.fn(async () => null);
    await expect(buy(deps(world, { resalePolicy: () => ({ getPublicOffer: hidden }) }).all)).rejects.toMatchObject({ status: 404 });
    expect(hidden).toHaveBeenCalledWith(ticket.eventId, offer.id);

    const listed = deps(world, { resalePolicy: () => ({ getPublicOffer: async () => ({ offerId: offer.id }) }) });
    await expect(buy(listed.all)).resolves.toMatchObject({ offerId: offer.id, amountDrops: "3000000" });
  });

  it("refuses to hand over a ticket that was used after its offer was made", async () => {
    const { seller, friend, event, ticket, offer, live } = await activeOffer("GIFT");
    await db.checkInRecord.create({
      data: { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: HOLDER },
    });
    const { all, create } = deps({ ...holding(), sellOffers: [live] });

    await expect(requestPurchase(all, { session: session(friend.id, FRIEND), offerId: offer.id })).rejects.toThrow(
      "already been used",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("records the new owner from the validated transfer and leaves the primary sale alone", async () => {
    const { friend, ticket, offer, live, soldAt } = await activeOffer("PRIVATE");
    const { all } = deps({ ...holding(), sellOffers: [live] });
    await requestPurchase(all, { session: session(friend.id, FRIEND), offerId: offer.id });

    const accepted = deps({
      holder: FRIEND,
      status: "CONFIRMED",
      sellOffers: [],
      confirmed: { transactionType: "NFTokenAcceptOffer", account: FRIEND, offerIndex: null },
    });
    const status = await getOfferStatus(accepted.all, offer.id);

    expect(status.offer).toMatchObject({ state: "ACCEPTED" });
    const after = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.cachedOwnerAddress).toBe(FRIEND);
    expect(after.primarySoldAt).toEqual(soldAt);
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).acceptedByAddress).toBe(FRIEND);
  });
});
