import { mintingDeps } from "@/lib/xrpl/tickets/server";

import type { CollectibleDeps } from "./ledger";

/**
 * Production wiring for the collectible services (route handlers and server components): the same
 * database, wallet service, ledger reader, network and public base URL as the ticket services.
 */
export function collectibleDeps(): CollectibleDeps {
  return mintingDeps();
}
