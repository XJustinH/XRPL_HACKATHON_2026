import "dotenv/config";
import { resetServerEnvCache } from "@/lib/env";

/**
 * Per-worker setup for the `db` Vitest project: code under test that calls
 * `getDb()` (route handlers, repositories) must hit the disposable test database,
 * never the dev database from `.env`.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
if (!new URL(url).pathname.endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must name a separate *_test database");
}

process.env.DATABASE_URL = url;
process.env.APP_BASE_URL = "http://localhost:3000";
resetServerEnvCache();
