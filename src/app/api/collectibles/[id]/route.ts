import { connection } from "next/server";

import { UpdateCollectibleBody } from "@/contracts/collectibles";
import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { reconcileCollectible } from "@/features/collectibles/ledger";
import { findCollectible, toCollectibleView, updateCollectible } from "@/features/collectibles/listings";
import { collectibleDeps } from "@/features/collectibles/server";
import { getRequestSession, requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/collectibles/:id: a published collectible with its editions (public), or the
 * seller's own draft. Mints, listings and purchases in flight are reconciled first.
 * 200 { data: CollectibleView } · 404 unknown, or someone else's draft.
 */
export const GET = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const id = await idOf(ctx);
  const deps = collectibleDeps();
  const session = await getRequestSession(req, deps.db);
  await findCollectible(deps.db, id, session?.userId ?? null);
  await reconcileCollectible(deps, id);
  const row = await findCollectible(deps.db, id, session?.userId ?? null);
  return jsonOk(toCollectibleView(row, deps.config), { requestId, headers: NO_STORE });
});

/**
 * PATCH /api/collectibles/:id: the seller edits a draft, or publishes it with
 * `{ "status": "PUBLISHED" }` (XRPL-072). Publishing makes the media and metadata public and
 * creates one token per edition with its stable metadata URI.
 * 200 { data: CollectibleView } · 401 · 403 not the seller · 404 · 409 editing a published collectible.
 */
export const PATCH = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const id = await idOf(ctx);
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const body = await parseJsonBody(req, UpdateCollectibleBody);
  const row = await updateCollectible(deps, session, id, body);
  return jsonOk(toCollectibleView(row, deps.config), { requestId, headers: NO_STORE });
});
