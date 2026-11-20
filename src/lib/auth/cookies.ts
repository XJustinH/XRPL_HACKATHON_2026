/**
 * Minimal cookie parsing/serialisation for route handlers (RFC 6265 subset).
 * Kept framework-free so handlers can be exercised with a plain `Request`.
 */

export function parseCookieHeader(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      continue; // malformed encoding: ignore this cookie rather than fail the request
    }
    // First occurrence wins, matching browser ordering (most specific path first).
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export type CookieOptions = {
  expires?: Date;
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
};

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) throw new Error(`Invalid cookie name: ${name}`);
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`];
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}
