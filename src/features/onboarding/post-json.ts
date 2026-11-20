/**
 * Client-side POST helper that understands the API envelope
 * (`{ data }` / `{ error: { code, message }, requestId }`).
 */
export type PostResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

export async function postJson<T>(url: string, body: unknown): Promise<PostResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "NETWORK_ERROR", message: NETWORK_ERROR };
  }

  const payload: unknown = await res.json().catch(() => null);
  if (res.ok && payload && typeof payload === "object" && "data" in payload) {
    return { ok: true, data: (payload as { data: T }).data };
  }
  const error =
    payload && typeof payload === "object" && "error" in payload
      ? (payload as { error: { code?: unknown; message?: unknown } }).error
      : null;
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : `HTTP_${res.status}`,
    message: typeof error?.message === "string" ? error.message : "Something went wrong. Please try again.",
  };
}
