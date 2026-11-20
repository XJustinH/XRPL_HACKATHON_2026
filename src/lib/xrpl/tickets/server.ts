import { getDb } from "@/lib/db/client";

import { loadXrplConfig } from "../config";
import { getXrplQueryService } from "../query";
import { getWalletTransactionRequests } from "../wallet/transaction-requests";
import type { MintDeps } from "./minting";
import { ticketPublicBaseUrl } from "./urls";

/** Production wiring for the minting service (route handlers and server components). */
export function mintingDeps(): MintDeps {
  return {
    db: getDb(),
    transactions: () => getWalletTransactionRequests(),
    ledger: () => getXrplQueryService(),
    config: loadXrplConfig(),
    baseUrl: ticketPublicBaseUrl(),
  };
}
