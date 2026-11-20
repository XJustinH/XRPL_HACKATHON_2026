import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/db/client";

import { loadXrplConfig, type XrplConfig } from "../config";
import { getXrplQueryService, type XrplQueryService } from "../query";
import { getWalletTransactionRequests, type WalletTransactionRequests } from "../wallet/transaction-requests";
import { ticketPublicBaseUrl } from "./urls";

/**
 * Everything the ticket services need, fully typed, so one object satisfies each service's
 * narrower dependencies: minting (XRPL-024/025), mapping (026), offers (029) and purchases (031).
 */
export interface TicketingDeps {
  db: PrismaClient;
  transactions: () => WalletTransactionRequests;
  ledger: () => XrplQueryService;
  config: XrplConfig;
  baseUrl: string;
}

/** Production wiring for the ticket services (route handlers and server components). */
export function mintingDeps(): TicketingDeps {
  return {
    db: getDb(),
    transactions: () => getWalletTransactionRequests(),
    ledger: () => getXrplQueryService(),
    config: loadXrplConfig(),
    baseUrl: ticketPublicBaseUrl(),
  };
}
