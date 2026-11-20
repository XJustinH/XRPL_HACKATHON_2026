// Loads `.env` for local runs. Never overrides variables the host already set (e.g. on Vercel).
import "dotenv/config";
import { getServerEnv } from "@/lib/env";
import { loadXrplConfig } from "@/lib/xrpl";

/**
 * Deployment preflight (XRPL-009), run by scripts/deploy/vercel-build.sh before anything else.
 *
 * Validates the same server environment the app reads at request time. A deployment with a
 * missing or invalid variable (e.g. no SESSION_SECRET, which production requires) then fails its
 * build with a message naming the variable, instead of going live with every API route
 * returning 500. Prints names and non-secret settings only, never values of secrets.
 */
try {
  const env = getServerEnv();
  const xrpl = loadXrplConfig();
  console.log(
    `Environment OK: NODE_ENV=${env.NODE_ENV}, XRPL network ${xrpl.network}, ` +
      `demo login ${env.DEMO_LOGIN_ENABLED ? "on" : "off"}, APP_BASE_URL ${env.APP_BASE_URL}`,
  );
} catch (error: unknown) {
  console.error(`Deployment environment is invalid: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
