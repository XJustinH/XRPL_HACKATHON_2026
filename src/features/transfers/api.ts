/** Browser calls for the transfer screens, in the same style as the purchase flow (XRPL-031). */

export class ApiError extends Error {
  constructor(
    message: string,
    /** False when no response arrived, so the same request may be retried with the same key. */
    readonly responded: boolean,
  ) {
    super(message);
  }
}

export async function callApi<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", false);
  }
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!response.ok || body.data === undefined) {
    throw new ApiError(body.error?.message ?? `Request failed (HTTP ${response.status})`, true);
  }
  return body.data;
}

/** Random key for `Idempotency-Key`. getRandomValues works on plain-http LAN addresses too. */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** "rPT1Sj…bpAYe": enough to recognise an address without filling the screen. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}

/** Format check only; the server verifies the checksum. Same alphabet as the shared contract. */
export const XRPL_ADDRESS_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
