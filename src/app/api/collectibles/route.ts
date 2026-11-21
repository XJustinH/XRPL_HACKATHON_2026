import { connection } from "next/server";

import { CreateCollectibleBody } from "@/contracts/collectibles";
import { NO_STORE } from "@/features/collectibles/http";
import { reconcileSellerCollectibles } from "@/features/collectibles/ledger";
import { createCollectible, listSellerCollectibles, toCollectibleView } from "@/features/collectibles/listings";
import { collectibleDeps } from "@/features/collectibles/server";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/collectibles: a seller creates a draft collectible from media they uploaded (XRPL-072).
 * Body `CreateCollectibleBody`. 201 { data: CollectibleView }. 401 · 403 not a seller ·
 * 404 when the media is not the seller's own upload.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const body = await parseJsonBody(req, CreateCollectibleBody);
  const row = await createCollectible(deps.db, session, body);
  return jsonOk(toCollectibleView(row, deps.config), { requestId, status: 201, headers: NO_STORE });
});

/**
 * GET /api/collectibles: the signed-in seller's own collectibles, drafts included, after
 * reconciling mints and sale listings in flight. 200 { data: CollectibleView[] }.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  requireEventManager(session);
  await reconcileSellerCollectibles(deps, session.userId);
  const rows = await listSellerCollectibles(deps.db, session.userId, { includeDrafts: true });
  return jsonOk(
    rows.map((row) => toCollectibleView(row, deps.config)),
    { requestId, headers: NO_STORE },
  );
});
