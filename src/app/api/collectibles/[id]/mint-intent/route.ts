import { connection } from "next/server";

import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { requestCollectibleMint } from "@/features/collectibles/ledger";
import { collectibleDeps } from "@/features/collectibles/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";

/**
 * POST /api/collectibles/:id/mint-intent: the seller mints the next edition (XRPL-073).
 * 201 { data: CollectibleMintResult }: the claimed edition and an NFTokenMint to approve in Xaman.
 * The issuer is the session's proven wallet. The NFT ID is recorded only once the ledger
 * validates the mint (read it back from GET /api/collectibles/tokens/:id).
 * 401 · 403 not the seller / WALLET_NOT_VERIFIED · 404 · 409 draft, or every edition is minted.
 */
export const POST = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const collectibleId = await idOf(ctx);
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const result = await withLedgerErrors(() => requestCollectibleMint(deps, { session, collectibleId }));
  return jsonOk(result, { requestId, status: 201, headers: NO_STORE });
});
