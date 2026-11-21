import { randomUUID } from "node:crypto";

import {
  MEDIA_MAX_BYTES,
  MEDIA_SUPPORTED_SUMMARY,
  MediaUploadErrorCode,
  SUPPORTED_MEDIA_TYPES,
  type MediaAssetView,
} from "@/contracts/collectibles";
import type { MediaAsset, PrismaClient } from "@/generated/prisma/client";
import { requireEventManager } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, errors } from "@/lib/http/response";

import { getMediaStorage, type MediaStorage } from "./storage";

/**
 * Collectible media uploads (XRPL-070/071): validated, stored off-chain through `MediaStorage`,
 * and recorded with uploader, type, size and location. Media stays private until a collectible
 * that uses it is published.
 */

export interface AssetDeps {
  db: PrismaClient;
  storage: MediaStorage;
}

/** Production wiring: the shared database and the configured media storage. */
export function assetDeps(): AssetDeps {
  return { db: getDb(), storage: getMediaStorage() };
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));
const startsWith = (bytes: Uint8Array, ...signature: number[]) => signature.every((b, i) => bytes[i] === b);

/**
 * The media type a file really is, read from its signature (the browser's label and the file
 * name are not trusted). Null for anything that is not a supported image, audio or video file.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    const form = ascii(bytes, 8, 4);
    return form === "WEBP" ? "image/webp" : form === "WAVE" ? "audio/wav" : null;
  }
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 4, 4) === "ftyp") return ascii(bytes, 8, 3) === "M4A" ? "audio/mp4" : "video/mp4";
  if (startsWith(bytes, 0x1a, 0x45, 0xdf, 0xa3)) {
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes("webm") ? "video/webm" : null;
  }
  // MP3: an ID3 tag, or an MPEG audio frame header (11 sync bits, layer III).
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2) return "audio/mpeg";
  return null;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export function toMediaAssetView(asset: MediaAsset): MediaAssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    originalName: asset.originalName,
    rightsConfirmedAt: asset.rightsConfirmedAt.toISOString(),
    contentUrl: `/api/assets/${asset.id}/content`,
  };
}

/**
 * Stores one upload. 403 unless the account is a seller · 400 RIGHTS_NOT_CONFIRMED without the
 * rights declaration · 400 NO_FILE · 415 UNSUPPORTED_MEDIA_TYPE · 413 FILE_TOO_LARGE ·
 * 503 MEDIA_STORAGE_FAILED when the storage service does not accept the file.
 */
export async function uploadMediaAsset(
  deps: AssetDeps,
  input: { session: AuthSession; fileName: string; bytes: Uint8Array | null; rightsConfirmed: boolean },
): Promise<MediaAsset> {
  requireEventManager(input.session);
  if (!input.rightsConfirmed) {
    throw new AppError(
      MediaUploadErrorCode.RIGHTS_NOT_CONFIRMED,
      "Confirm that you hold the rights to this content before uploading it.",
      400,
    );
  }
  const bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    throw new AppError(MediaUploadErrorCode.NO_FILE, "Choose a file to upload.", 400);
  }
  const mimeType = sniffMediaType(bytes);
  const supported = mimeType ? SUPPORTED_MEDIA_TYPES[mimeType] : undefined;
  if (!mimeType || !supported) {
    throw new AppError(
      MediaUploadErrorCode.UNSUPPORTED_MEDIA_TYPE,
      `This file type is not supported. Supported: ${MEDIA_SUPPORTED_SUMMARY}.`,
      415,
    );
  }
  const limit = MEDIA_MAX_BYTES[supported.kind];
  if (bytes.length > limit) {
    throw new AppError(
      MediaUploadErrorCode.FILE_TOO_LARGE,
      `This ${supported.kind.toLowerCase()} file is ${megabytes(bytes.length)}; the limit is ${megabytes(limit)}.`,
      413,
    );
  }

  const storageKey = `${randomUUID()}.${supported.extension}`;
  try {
    await deps.storage.put(storageKey, bytes);
  } catch (error) {
    console.error("[collectibles] media storage refused an upload", error);
    throw new AppError(
      MediaUploadErrorCode.MEDIA_STORAGE_FAILED,
      "The file could not be stored. Nothing was saved; try again shortly.",
      503,
      { retryable: true },
    );
  }
  try {
    return await deps.db.mediaAsset.create({
      data: {
        uploaderId: input.session.userId,
        kind: supported.kind,
        mimeType,
        sizeBytes: bytes.length,
        storageKey,
        // Display only; never used as a path.
        originalName: input.fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "upload",
        rightsConfirmedAt: new Date(),
      },
    });
  } catch (error) {
    await deps.storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * The asset, if `viewerUserId` may see it: it belongs to a published collectible, or the viewer
 * uploaded it. Unpublished media is never exposed to anyone else (reported as 404).
 */
export async function findViewableAsset(
  db: Pick<PrismaClient, "mediaAsset">,
  assetId: string,
  viewerUserId: string | null,
): Promise<{ asset: MediaAsset; isPublic: boolean }> {
  const asset = await db.mediaAsset.findUnique({
    where: { id: assetId },
    include: { collectibles: { where: { status: "PUBLISHED" }, select: { id: true }, take: 1 } },
  });
  if (!asset) throw errors.notFound("Media not found");
  const { collectibles, ...row } = asset;
  const isPublic = collectibles.length > 0;
  if (!isPublic && row.uploaderId !== viewerUserId) throw errors.notFound("Media not found");
  return { asset: row, isPublic };
}
