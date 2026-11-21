import {
  MEDIA_MAX_BYTES,
  MEDIA_SUPPORTED_SUMMARY,
  SUPPORTED_MEDIA_TYPES,
  type MediaAssetView,
  type MediaKind,
} from "@/contracts/collectibles";

/** Browser-side calls for the collectible UI. */

export async function callApi<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!response.ok || body.data === undefined) {
    throw new Error(body.error?.message ?? `Request failed (HTTP ${response.status})`);
  }
  return body.data;
}

export const postJson = <T>(url: string, body: unknown = {}, method = "POST") =>
  callApi<T>(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * A quick check before uploading, so an obviously wrong file fails at once. The server decides
 * for real, from the file's own contents. Returns a message, or null when the file looks fine.
 */
export function checkMediaFile(file: File): string | null {
  if (file.size === 0) return "This file is empty.";
  const known = SUPPORTED_MEDIA_TYPES[file.type]?.kind;
  const kind: MediaKind | null =
    known ?? (file.type.startsWith("audio/") ? "AUDIO" : file.type.startsWith("video/") ? "VIDEO" : null);
  if (!kind) return `This file type is not supported. Supported: ${MEDIA_SUPPORTED_SUMMARY}.`;
  if (file.size > MEDIA_MAX_BYTES[kind]) {
    return `This ${kind.toLowerCase()} file is ${megabytes(file.size)}; the limit is ${megabytes(MEDIA_MAX_BYTES[kind])}.`;
  }
  return null;
}

/**
 * Uploads collectible media with the rights declaration, reporting progress as a percentage
 * (XMLHttpRequest, because fetch cannot report upload progress). Rejects with the server's own
 * message for an invalid file or failed storage.
 */
export function uploadMedia(file: File, onProgress: (percent: number) => void): Promise<MediaAssetView> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("rightsConfirmed", "true");
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/assets");
    xhr.responseType = "json";
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.onabort = () => reject(new Error("The upload was cancelled."));
    xhr.onload = () => {
      const body = xhr.response as { data?: MediaAssetView; error?: { message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.data) resolve(body.data);
      else reject(new Error(body?.error?.message ?? `The upload failed (HTTP ${xhr.status}). Try again.`));
    };
    xhr.send(form);
  });
}
