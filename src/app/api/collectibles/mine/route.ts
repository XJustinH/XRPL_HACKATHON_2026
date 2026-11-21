import { connection } from "next/server";

import { NO_STORE } from "@/features/collectibles/http";
import { listOwnedCollectibles } from "@/features/collectibles/ledger";
import { collectibleDeps } from "@/features/collectibles/server";
import { requireProvenWallet } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";

/**
 * GET /api/collectibles/mine: the collectible NFTs the session's proven wallet holds right now
 * (XRPL-075), each checked on a validated ledger. Never includes tickets.
 * 200 { data: OwnedCollectible[] } · 401 · 403 WALLET_NOT_VERIFIED · 503 when the ledger can't be read.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const address = requireProvenWallet(session);
  const owned = await withLedgerErrors(() => listOwnedCollectibles(deps, { address }));
  return jsonOk(owned, { requestId, headers: NO_STORE });
});
