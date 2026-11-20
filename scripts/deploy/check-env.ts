// Loads `.env` for local runs. Never overrides variables the host already set (e.g. on Vercel).
import "dotenv/config";
import { getServerEnv } from "@/lib/env";
import { isPubliclyReachable, loadXrplConfig, ticketPublicBaseUrl } from "@/lib/xrpl";

/**
 * Deployment preflight (XRPL-009), run by scripts/deploy/vercel-build.sh before anything else.
 *
 * Validates the same server environment the app reads at request time. A deployment with a
 * missing or invalid variable (e.g. no SESSION_SECRET, which production requires) then fails its
 * build with a message naming the variable, instead of going live with every API route
 * returning 500. Prints names and non-secret settings only, never values of secrets.
 *
 * Production also needs a public https address for ticket metadata: every minted ticket NFT stores
 * that link permanently, so a wrong value can't be fixed for tickets already minted.
 */
try {
  const env = getServerEnv();
  const xrpl = loadXrplConfig();
  const metadataBase = ticketPublicBaseUrl();
  const metadataPublic = metadataBase.startsWith("https://") && isPubliclyReachable(metadataBase);

  if (process.env.VERCEL_ENV === "production" && !metadataPublic) {
    throw new Error(
      `ticket metadata would be published at ${metadataBase}, which isn't a public https address. ` +
        "Set APP_BASE_URL (or TICKET_METADATA_BASE_URL) to the production https address before tickets are minted.",
    );
  }

  console.log(
    `Environment OK: NODE_ENV=${env.NODE_ENV}, XRPL network ${xrpl.network}, ` +
      `demo login ${env.DEMO_LOGIN_ENABLED ? "on" : "off"}, APP_BASE_URL ${env.APP_BASE_URL}, ` +
      `ticket metadata ${metadataBase}${metadataPublic ? "" : " (not public: explorers can't show minted tickets)"}`,
  );
} catch (error: unknown) {
  console.error(`Deployment environment is invalid: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
