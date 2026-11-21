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
 * Every record is labelled as demo content (DEMO_LABEL / DEMO_NOTICE), and demo users have
 * `isDemo = true`.
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
    warehouseParty: demoId(104),
    djAllNighter: demoId(105),
    neonClubNight: demoId(106),
    summerFestival: demoId(107),
    ledgerTalks: demoId(108),
  },
  tiers: {
    headlineGeneralAdmission: demoId(201),
    headlineVip: demoId(202),
    openMicStandard: demoId(203),
    corkGeneralAdmission: demoId(204),
    warehousePartyEntry: demoId(205),
    djAllNighterEntry: demoId(206),
    neonClubEntry: demoId(207),
    summerFestivalDay: demoId(208),
    ledgerTalksSeat: demoId(209),
  },
} as const;

/** When the demo personas "completed onboarding" and the published events "went live". */
const SEEDED_AT = new Date("2026-11-20T09:00:00.000Z");

/**
 * Shared by every demo user. `isDemo` is the flag code should use to detect demo accounts, and it
 * lets demo login offer the account as a persona (XRPL-010, DEMO_LOGIN_ENABLED). The seed restores
 * it on every run (see seed-demo-data.ts).
 */
const demoPersona = { isDemo: true, onboardedAt: SEEDED_AT } as const;

export const demoUsers = [
  {
    id: DEMO_IDS.users.artistSeller,
    role: "SELLER",
    displayName: "The Testnet Tones",
    ...demoPersona,
  },
  {
    id: DEMO_IDS.users.venueSeller,
    role: "SELLER",
    displayName: "The Ledger Rooms",
    ...demoPersona,
  },
  {
    id: DEMO_IDS.users.organiser,
    role: "ORGANISER",
    displayName: "Door Team",
    ...demoPersona,
  },
  {
    id: DEMO_IDS.users.customer,
    role: "CUSTOMER",
    displayName: "Alex Fan",
    ...demoPersona,
  },
  {
    // Recipient for the private-sale / gift / resale steps of the demo.
    id: DEMO_IDS.users.secondCustomer,
    role: "CUSTOMER",
    displayName: "Sam Friend",
    ...demoPersona,
  },
] as const satisfies readonly Prisma.UserCreateManyInput[];

// Fixed dates well after the hackathon so published events stay "upcoming" for the demo.
//
// Artwork points at Unsplash's CDN rather than anything committed here: the column holds an
// arbitrary seller-supplied URL, and the cards render it with a plain `img` that hides a broken
// link (see event-card.tsx), so a dead URL costs a placeholder rather than an error.
export const demoEvents = [
  {
    id: DEMO_IDS.events.headlineShow,
    sellerId: DEMO_IDS.users.artistSeller,
    title: "The Testnet Tones: Live at The Ledger Rooms",
    description: `${DEMO_NOTICE} An evening of original songs from a fictional band, used to demonstrate minting, buying, transferring and checking in with NFT tickets.`,
    startsAt: new Date("2027-03-12T20:00:00.000Z"),
    endsAt: new Date("2027-03-12T23:00:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    artworkUrl: "https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=1200&q=80",
    category: "MUSIC",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.openMicNight,
    sellerId: DEMO_IDS.users.venueSeller,
    title: "Open Mic Night at The Ledger Rooms",
    description: `${DEMO_NOTICE} A fictional open mic night hosted by a demo venue, for browsing by organiser.`,
    startsAt: new Date("2027-04-02T19:00:00.000Z"),
    endsAt: new Date("2027-04-02T22:30:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    artworkUrl: "https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=1200&q=80",
    category: "COMEDY",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    // Draft: visible to its seller only. Exercises the draft/edit/publish flow.
    id: DEMO_IDS.events.corkDraft,
    sellerId: DEMO_IDS.users.artistSeller,
    title: "The Testnet Tones: Cork (draft)",
    description: `${DEMO_NOTICE} An unpublished tour date, kept as a draft for the seller dashboard.`,
    startsAt: new Date("2027-05-21T20:00:00.000Z"),
    endsAt: new Date("2027-05-21T23:00:00.000Z"),
    venue: "Harbour Stage (demo venue)",
    city: "Cork",
    artworkUrl: "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1200&q=80",
    category: "MUSIC",
    status: "DRAFT",
    publishedAt: null,
  },
  {
    id: DEMO_IDS.events.warehouseParty,
    sellerId: DEMO_IDS.users.venueSeller,
    title: "Warehouse Party: Ledger After Dark",
    description: `${DEMO_NOTICE} A fictional late-night warehouse party, used to fill the listing with more than one category.`,
    startsAt: new Date("2027-03-20T22:00:00.000Z"),
    endsAt: new Date("2027-03-21T04:00:00.000Z"),
    venue: "Dock Warehouse (demo venue)",
    city: "Dublin",
    artworkUrl: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1200&q=80",
    category: "CLUB",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.djAllNighter,
    sellerId: DEMO_IDS.users.venueSeller,
    title: "All-Nighter: Resident DJs",
    description: `${DEMO_NOTICE} A fictional club night with resident DJs, for browsing and filtering by category.`,
    startsAt: new Date("2027-04-10T23:00:00.000Z"),
    endsAt: new Date("2027-04-11T05:00:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    artworkUrl: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=1200&q=80",
    category: "CLUB",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.neonClubNight,
    sellerId: DEMO_IDS.users.venueSeller,
    title: "Neon: Friday Club Night",
    description: `${DEMO_NOTICE} A fictional weekly club night in Galway, kept cheap so it can sell out quickly in a demo.`,
    startsAt: new Date("2027-04-23T22:30:00.000Z"),
    endsAt: new Date("2027-04-24T03:00:00.000Z"),
    venue: "Neon Room (demo venue)",
    city: "Galway",
    artworkUrl: "https://images.unsplash.com/photo-1545128485-c400e7702796?w=1200&q=80",
    category: "CLUB",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.summerFestival,
    sellerId: DEMO_IDS.users.artistSeller,
    title: "Testnet Summer Festival",
    description: `${DEMO_NOTICE} A fictional one-day festival, the largest demo event, for showing a bigger ticket supply.`,
    startsAt: new Date("2027-07-17T14:00:00.000Z"),
    endsAt: new Date("2027-07-17T23:30:00.000Z"),
    venue: "Harbour Fields (demo venue)",
    city: "Cork",
    artworkUrl: "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=1200&q=80",
    category: "MUSIC",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
  },
  {
    id: DEMO_IDS.events.ledgerTalks,
    sellerId: DEMO_IDS.users.venueSeller,
    title: "Ledger Talks: Ticketing on XRPL",
    description: `${DEMO_NOTICE} A fictional evening of talks, included so the listing spans more than music and comedy.`,
    startsAt: new Date("2027-05-14T18:30:00.000Z"),
    endsAt: new Date("2027-05-14T21:00:00.000Z"),
    venue: "The Ledger Rooms (demo venue)",
    city: "Dublin",
    artworkUrl: "https://images.unsplash.com/photo-1558008258-3256797b43f3?w=1200&q=80",
    category: "TALKS",
    status: "PUBLISHED",
    publishedAt: SEEDED_AT,
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
  {
    id: DEMO_IDS.tiers.warehousePartyEntry,
    eventId: DEMO_IDS.events.warehouseParty,
    name: "Entry",
    description: TIER_NOTICE,
    priceDrops: "1500000",
    totalSupply: 8,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.djAllNighterEntry,
    eventId: DEMO_IDS.events.djAllNighter,
    name: "Entry",
    description: TIER_NOTICE,
    priceDrops: "2000000",
    totalSupply: 6,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.neonClubEntry,
    eventId: DEMO_IDS.events.neonClubNight,
    name: "Entry",
    description: TIER_NOTICE,
    priceDrops: "800000",
    totalSupply: 4,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.summerFestivalDay,
    eventId: DEMO_IDS.events.summerFestival,
    name: "Day Ticket",
    description: TIER_NOTICE,
    priceDrops: "4500000",
    totalSupply: 12,
    sortOrder: 0,
  },
  {
    id: DEMO_IDS.tiers.ledgerTalksSeat,
    eventId: DEMO_IDS.events.ledgerTalks,
    name: "Seat",
    description: TIER_NOTICE,
    priceDrops: "500000",
    totalSupply: 10,
    sortOrder: 0,
  },
] as const satisfies readonly Prisma.TicketTierCreateManyInput[];
