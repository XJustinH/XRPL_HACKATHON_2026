import { execSync } from "node:child_process";
import { createPrismaClient } from "@/lib/db/client";
import { seedDemoData } from "../../scripts/seed/seed-demo-data";

/**
 * Run by global-setup.ts with DATABASE_URL pointing at the *_test database: apply migrations, empty
 * every table, then insert the demo seed, so each run starts from the same known data.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Refusing to empty a database not named *_test");

  execSync("npx prisma migrate deploy", { stdio: "inherit" });

  const db = createPrismaClient(url);
  try {
    await db.$executeRawUnsafe(`
      DO $$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
          EXECUTE format('TRUNCATE TABLE %I CASCADE', t.tablename);
        END LOOP;
      END $$;
    `);
    const summary = await seedDemoData(db);
    console.log(`e2e database ready: ${summary.users.created} demo users, ${summary.events.created} events`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
