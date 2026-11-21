import { createPrismaClient } from "@/lib/db/client";
import { DEMO_IDS } from "../../scripts/seed/fixtures";

/**
 * Layout fixtures for the phone-size checks (XRPL-051), added to the headline demo event:
 *
 *  - one minted ticket listed for sale, so the event page and the checkout have a ticket to show;
 *  - one sold ticket that was checked in, so the organiser's check-in chart has a bar to draw.
 *
 * Run by mobile-accessibility.spec.ts under tsx, with DATABASE_URL pointing at the *_test database.
 * The demo seed never contains tickets, offers or check-ins, because those must come from validated
 * ledger transactions. These rows exist only in the emptied *_test database, and nothing here is
 * submitted to a ledger: the checks stop before any wallet step.
 */

const LISTED = { ticketId: "5eed0000-0000-4000-8000-000000000901", offerId: "5eed0000-0000-4000-8000-000000000902" };
const USED = { ticketId: "5eed0000-0000-4000-8000-000000000903", checkInId: "5eed0000-0000-4000-8000-000000000904" };
const PRICE_DROPS = "25000000";
const SELLER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const HOLDER_WALLET = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const hex64 = (pair: string) => pair.repeat(32);
const nftId = (pair: string) => `00080000${pair.repeat(28)}`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Refusing to add fixtures to a database not named *_test");

  const db = createPrismaClient(url);
  const ticket = { eventId: DEMO_IDS.events.headlineShow, tierId: DEMO_IDS.tiers.headlineGeneralAdmission };
  try {
    await db.checkInRecord.deleteMany({ where: { id: USED.checkInId } });
    await db.nFTOffer.deleteMany({ where: { id: LISTED.offerId } });
    await db.ticketNFT.deleteMany({ where: { id: { in: [LISTED.ticketId, USED.ticketId] } } });

    await db.ticketNFT.create({
      data: {
        ...ticket,
        id: LISTED.ticketId,
        serial: 1,
        mintStatus: "MINTED",
        nftokenId: nftId("A1"),
        issuerAddress: SELLER_WALLET,
        mintTxHash: hex64("C3"),
        mintedAt: new Date(),
        cachedOwnerAddress: SELLER_WALLET,
      },
    });
    await db.nFTOffer.create({
      data: {
        id: LISTED.offerId,
        ticketId: LISTED.ticketId,
        nftokenId: nftId("A1"),
        offerIndex: hex64("B2"),
        kind: "PRIMARY",
        state: "ACTIVE",
        ownerAddress: SELLER_WALLET,
        amountDrops: PRICE_DROPS,
        createTxHash: hex64("D4"),
      },
    });

    await db.ticketNFT.create({
      data: {
        ...ticket,
        id: USED.ticketId,
        serial: 2,
        mintStatus: "MINTED",
        nftokenId: nftId("E5"),
        issuerAddress: SELLER_WALLET,
        mintTxHash: hex64("F6"),
        mintedAt: new Date(),
        primarySoldAt: new Date(),
        primarySaleTxHash: hex64("A7"),
        cachedOwnerAddress: HOLDER_WALLET,
      },
    });
    await db.checkInRecord.create({
      data: {
        id: USED.checkInId,
        ticketId: USED.ticketId,
        eventId: ticket.eventId,
        organiserId: DEMO_IDS.users.artistSeller,
        walletAddress: HOLDER_WALLET,
        scannedAt: new Date(),
      },
    });
    console.log("e2e fixtures ready: one listed ticket and one checked-in ticket for the headline event");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
