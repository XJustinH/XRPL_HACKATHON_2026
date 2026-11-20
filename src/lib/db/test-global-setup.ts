import { execSync } from "node:child_process";
import "dotenv/config";

/**
 * Vitest globalSetup for the `db` project: applies pending migrations to the dedicated
 * test database. Tests truncate their own tables, so the target MUST be a disposable DB.
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");

  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test") || url === process.env.DATABASE_URL) {
    throw new Error(
      `Refusing to run DB tests against "${dbName}": TEST_DATABASE_URL must name a separate *_test database`,
    );
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
