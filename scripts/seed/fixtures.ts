import type { Prisma } from "@/generated/prisma/client";

/**
 * Demo seed fixtures (XRPL-008).
 *
 * Off-chain sample data only: users, events and ticket tiers, so the UI is usable before the
 * ledger work lands. Deliberately NOT seeded:
 *  - wallet links: a stored address proves nothing, and control is only established by a
 *    wallet-signed challenge (XRPL-012), so demo wallets are linked live during the demo;
 *  - ticket NFTs, offers and ledger transactions: these must come from validated XRPL Testnet
 *    transactions, never from fixtures.
 *
 * Every record has a fixed ID so the seed is idempotent and tests/demo scripts can refer to
 * records by ID. IDs share the recognisable `5eed0000-` prefix and are valid v4-format UUIDs.
 * Every record is labelled as demo content (DEMO_LABEL / DEMO_NOTICE, `settings.demo`).
 */

export const DEMO_LABEL = "[DEMO]";

export const DEMO_NOTICE =
  "Demo content for the XRPL Testnet prototype. This is not a real event, and its tickets have no monetary value.";

const demoId = (n: number) => `5eed0000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

export const DEMO_IDS = {
  users: {
    artistSeller: demoId(1),
    venueSeller: demoId(2),
    organiser: demoId(3),
    customer: demoId(4),
    secondCustomer: demoId(5),
  },
  events: {
    headlineShow: demoId(101),
    openMicNight: demoId(102),
    corkDraft: demoId(103),
  },
  tiers: {
    headlineGeneralAdmission: demoId(201),
    headlineVip: demoId(202),
    openMicStandard: demoId(203),
    corkGeneralAdmission: demoId(204),
  },
} as const;

/** When the demo personas "completed onboarding" and the published events "went live". */
const SEEDED_AT = new Date("2026-11-20T09:00:00.000Z");

/** Marker stored in `User.settings` so demo accounts can be detected in code, not just by name. */
export const DEMO_USER_SETTINGS = { demo: true } as const;

export const demoUsers = [
  {
    id: DEMO_IDS.users.artistSeller,
    role: "SELLER",
    displayName: `${DEMO_LABEL} The Testnet Tones`,
    settings: DEMO_USER_SETTINGS,
    onboardedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.users.venueSeller,
    role: "SELLER",
    displayName: `${DEMO_LABEL} The Ledger Rooms`,
    settings: DEMO_USER_SETTINGS,
    onboardedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.users.organiser,
    role: "ORGANISER",
    displayName: `${DEMO_LABEL} Door Team`,
    settings: DEMO_USER_SETTINGS,
    onboardedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.users.customer,
    role: "CUSTOMER",
    displayName: `${DEMO_LABEL} Alex Fan`,
    settings: DEMO_USER_SETTINGS,
    onboardedAt: SEEDED_AT,
  },
  {
    // Recipient for the private-sale / gift / resale steps of the demo.
    id: DEMO_IDS.users.secondCustomer,
    role: "CUSTOMER",
    displayName: `${DEMO_LABEL} Sam Friend`,
    settings: DEMO_USER_SETTINGS,
    onboardedAt: SEEDED_AT,
  },
] as const satisfies readonly Prisma.UserCreateManyInput[];

// Fixed dates well after the hackathon so published events stay "upcoming" for the demo.
export const demoEvents = [
  {
    id: DEMO_IDS.events.headlineShow,
    sellerId: DEMO_IDS.users.artistSeller,
    title: `${DEMO_LABEL} The Testnet Tones: Live at The Ledger Rooms`,
    description: `${DEMO_NOTICE} An evening of original songs from a fictional band, used to demonstrate minting, buying, transferring and checking in with NFT tickets.`,
    startsAt: new Date("2027-03-12T20:00:00.000Z"),
    endsAt: new Date("2027-03-12T23:00:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.openMicNight,
    sellerId: DEMO_IDS.users.venueSeller,
    title: `${DEMO_LABEL} Open Mic Night at The Ledger Rooms`,
    description: `${DEMO_NOTICE} A fictional open mic night hosted by a demo venue, for browsing by organiser.`,
    startsAt: new Date("2027-04-02T19:00:00.000Z"),
    endsAt: new Date("2027-04-02T22:30:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    // Draft: visible to its seller only. Exercises the draft/edit/publish flow.
    id: DEMO_IDS.events.corkDraft,
    sellerId: DEMO_IDS.users.artistSeller,
    title: `${DEMO_LABEL} The Testnet Tones: Cork (draft)`,
    description: `${DEMO_NOTICE} An unpublished tour date, kept as a draft for the seller dashboard.`,
    startsAt: new Date("2027-05-21T20:00:00.000Z"),
    endsAt: new Date("2027-05-21T23:00:00.000Z"),
    venue: "Harbour Stage (demo venue)",
    city: "Cork",
    status: "DRAFT",
    publishedAt: null,
  },
] as const satisfies readonly Prisma.EventCreateManyInput[];

const TIER_NOTICE = "Demo tier on XRPL Testnet. No monetary value.";

// Supplies are deliberately small so the primary sale can sell out during a live demo, which
// is what unlocks in-app resale (XRPL-037). Prices are integer drops (1 XRP = 1,000,000 drops).
export const demoTiers = [
  {
    id: DEMO_IDS.tiers.headlineGeneralAdmission,
    eventId: DEMO_IDS.events.headlineShow,
    name: "General Admission",
    description: TIER_NOTICE,
    priceDrops: "2500000",
    totalSupply: 3,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.headlineVip,
    eventId: DEMO_IDS.events.headlineShow,
    name: "VIP",
    description: TIER_NOTICE,
    priceDrops: "10000000",
    totalSupply: 1,
    sortOrder: 1,
  },
  {
    id: DEMO_IDS.tiers.openMicStandard,
    eventId: DEMO_IDS.events.openMicNight,
    name: "Standard",
    description: TIER_NOTICE,
    priceDrops: "1000000",
    totalSupply: 10,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.corkGeneralAdmission,
    eventId: DEMO_IDS.events.corkDraft,
    name: "General Admission",
    description: TIER_NOTICE,
    priceDrops: "3000000",
    totalSupply: 5,
    sortOrder: 0,
  },
] as const satisfies readonly Prisma.TicketTierCreateManyInput[];
