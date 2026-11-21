import "dotenv/config";
import { execSync } from "node:child_process";

/**
 * Prepares the database for the browser smoke tests: the *_test database, migrated, emptied and
 * filled with the demo seed. The work runs in prepare-db.ts under tsx, which loads the app's
 * TypeScript the same way the seed command does.
 */
export default function globalSetup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!new URL(url).pathname.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must name a separate *_test database: the e2e setup empties it");
  }
  // A command string, not an argument list: `npx` is a .cmd file on Windows, which needs a shell.
  execSync("npx tsx tests/e2e/prepare-db.ts", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
