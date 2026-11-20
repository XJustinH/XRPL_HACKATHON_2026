import "dotenv/config";
import { createPrismaClient } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import { DEMO_LABEL } from "./fixtures";
import { seedDemoData, type SeedTableSummary } from "./seed-demo-data";

/**
 * `npm run db:seed`: insert the labelled demo users, events and ticket tiers (XRPL-008).
 * Safe to run repeatedly. See docs/seed-data.md.
 */

const ALLOW_PRODUCTION_FLAG = "--allow-production";

const line = (label: string, s: SeedTableSummary) =>
  `  ${label.padEnd(13)} ${s.created} created, ${s.existing} already present`;

async function main(): Promise<void> {
  const env = getServerEnv();
  if (env.NODE_ENV === "production" && !process.argv.includes(ALLOW_PRODUCTION_FLAG)) {
    throw new Error(
      `Refusing to seed demo data with NODE_ENV=production. Pass ${ALLOW_PRODUCTION_FLAG} if this is a demo/preview database.`,
    );
  }

  // Print only the database name. The connection string contains credentials.
  const dbName = new URL(env.DATABASE_URL).pathname.replace(/^\//, "") || "(default)";
  console.log(`Seeding ${DEMO_LABEL} data into database "${dbName}"...`);

  const db = createPrismaClient(env.DATABASE_URL);
  try {
    const summary = await seedDemoData(db);
    console.log(line("users", summary.users));
    console.log(line("events", summary.events));
    console.log(line("ticket tiers", summary.tiers));
    if (summary.demoFlagsRestored > 0) {
      console.log(`  Restored isDemo on ${summary.demoFlagsRestored} existing demo user(s).`);
    }
    console.log(
      "Done. No wallets, ticket NFTs, offers or ledger transactions were seeded: those come from live XRPL Testnet activity.",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
