import { connection } from "next/server";

import { MEDIA_MAX_BYTES_ANY, MediaUploadErrorCode } from "@/contracts/collectibles";
import { assetDeps, toMediaAssetView, uploadMediaAsset } from "@/features/collectibles/assets";
import { NO_STORE } from "@/features/collectibles/http";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { AppError, errors, jsonOk, withApiHandler } from "@/lib/http/response";

/** Room for the multipart boundaries and the other form fields around the largest file. */
const MAX_BODY_BYTES = MEDIA_MAX_BYTES_ANY + 1024 * 1024;

/**
 * POST /api/assets: a seller uploads collectible media (XRPL-070/071).
 * multipart/form-data with `file` and `rightsConfirmed=true` (the rights declaration).
 * 201 { data: MediaAssetView }. The media is stored off-chain and stays private until a
 * collectible using it is published.
 * 401 without a session · 403 not a seller · 400 RIGHTS_NOT_CONFIRMED / NO_FILE ·
 * 415 UNSUPPORTED_MEDIA_TYPE · 413 FILE_TOO_LARGE · 503 MEDIA_STORAGE_FAILED.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  const deps = assetDeps();
  const session = await requireSession(req, deps.db);
  requireEventManager(session);

  // Refuse an oversized body before buffering it.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new AppError(
      MediaUploadErrorCode.FILE_TOO_LARGE,
      "This file is larger than any supported upload (50 MB).",
      413,
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw errors.validation(undefined, "Send the upload as multipart/form-data with a `file` field.");
  }
  const file = form.get("file");
  const upload = file instanceof File ? file : null;
  const asset = await uploadMediaAsset(deps, {
    session,
    fileName: upload?.name ?? "",
    bytes: upload ? new Uint8Array(await upload.arrayBuffer()) : null,
    rightsConfirmed: form.get("rightsConfirmed") === "true",
  });
  return jsonOk(toMediaAssetView(asset), { requestId, status: 201, headers: NO_STORE });
});
