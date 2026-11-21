import { connection } from "next/server";

import { assetDeps, findViewableAsset } from "@/features/collectibles/assets";
import { idOf, type IdContext } from "@/features/collectibles/http";
import { getRequestSession } from "@/lib/auth/session";
import { errors, withApiHandler } from "@/lib/http/response";

/** A ranged read returns at most this much; players ask for the next part themselves. */
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

type ByteRange = { start: number; end: number };

/** The single byte range asked for, null for "the whole file", or "invalid" (416). */
function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return { start, end: Math.min(end, start + MAX_RANGE_BYTES - 1) };
}

/**
 * GET /api/assets/:id/content: the bytes of uploaded collectible media (XRPL-071).
 * Served only when the asset belongs to a published collectible, or the requester uploaded it;
 * unpublished media is 404 for everyone else. Supports `Range` so audio and video can seek.
 * The type is the one confirmed at upload, sent with `nosniff`, so it is never run as a page.
 */
export const GET = withApiHandler<IdContext>(async (req, ctx) => {
  await connection();
  const id = await idOf(ctx, "Media not found");
  const deps = assetDeps();
  const session = await getRequestSession(req, deps.db);
  const { asset, isPublic } = await findViewableAsset(deps.db, id, session?.userId ?? null);

  const size = await deps.storage.size(asset.storageKey);
  if (size === null) throw errors.notFound("Media not found");
  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const bytes = await deps.storage.read(asset.storageKey, range ?? undefined);

  const headers = new Headers({
    "Content-Type": asset.mimeType,
    "Content-Length": String(bytes.length),
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": isPublic ? "public, max-age=3600" : "private, no-store",
  });
  if (isPublic) headers.set("Access-Control-Allow-Origin", "*");
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(Buffer.from(bytes), { status: range ? 206 : 200, headers });
});
