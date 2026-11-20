/**
 * Client for the event and tier endpoints.
 *
 * Differs from the shared `postJson` helper in two ways these screens need: it
 * supports PATCH and DELETE, and it keeps `error.details`, which carries the
 * publish blocker list and the names of mint-locked fields.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: unknown };

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";
const FALLBACK_ERROR = "Something went wrong. Please try again.";

export async function requestJson<T>(
  url: string,
  init: { method: "POST" | "PATCH" | "DELETE"; body?: unknown } = { method: "POST" },
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "NETWORK_ERROR", message: NETWORK_ERROR };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok && payload && typeof payload === "object" && "data" in payload) {
    return { ok: true, data: (payload as { data: T }).data };
  }

  const error =
    payload && typeof payload === "object" && "error" in payload
      ? (payload as { error: { code?: unknown; message?: unknown; details?: unknown } }).error
      : null;

  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : `HTTP_${response.status}`,
    message: typeof error?.message === "string" ? error.message : FALLBACK_ERROR,
    details: error?.details,
  };
}
