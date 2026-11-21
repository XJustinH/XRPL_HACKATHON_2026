import { createPrismaClient } from "@/lib/db/client";
import { DEMO_IDS } from "../../scripts/seed/fixtures";

/**
 * Layout fixture for the phone-size checks (XRPL-051): one minted ticket of the headline event,
 * listed for sale, so the event page and the checkout page have a ticket to show.
 *
 * Run by mobile-accessibility.spec.ts under tsx, with DATABASE_URL pointing at the *_test database.
 * The demo seed never contains tickets or offers, because those must come from validated ledger
 * transactions. This row exists only in the emptied *_test database, and nothing here is submitted
 * to a ledger: the checks stop before any wallet step.
 */

const LISTED_TICKET = {
  ticketId: "5eed0000-0000-4000-8000-000000000901",
  offerId: "5eed0000-0000-4000-8000-000000000902",
  serial: 1,
  priceDrops: "25000000",
} as const;

const NFT_ID = `00080000${"A1".repeat(28)}`;
const OFFER_INDEX = "B2".repeat(32);
const SELLER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Refusing to add a fixture to a database not named *_test");

  const db = createPrismaClient(url);
  try {
    await db.nFTOffer.deleteMany({ where: { id: LISTED_TICKET.offerId } });
    await db.ticketNFT.deleteMany({ where: { id: LISTED_TICKET.ticketId } });
    await db.ticketNFT.create({
      data: {
        id: LISTED_TICKET.ticketId,
        eventId: DEMO_IDS.events.headlineShow,
        tierId: DEMO_IDS.tiers.headlineGeneralAdmission,
        serial: LISTED_TICKET.serial,
        mintStatus: "MINTED",
        nftokenId: NFT_ID,
        issuerAddress: SELLER_WALLET,
        mintTxHash: "C3".repeat(32),
        mintedAt: new Date(),
        cachedOwnerAddress: SELLER_WALLET,
      },
    });
    await db.nFTOffer.create({
      data: {
        id: LISTED_TICKET.offerId,
        ticketId: LISTED_TICKET.ticketId,
        nftokenId: NFT_ID,
        offerIndex: OFFER_INDEX,
        kind: "PRIMARY",
        state: "ACTIVE",
        ownerAddress: SELLER_WALLET,
        amountDrops: LISTED_TICKET.priceDrops,
        createTxHash: "D4".repeat(32),
      },
    });
    console.log("e2e fixture ready: one listed ticket for the headline event");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
