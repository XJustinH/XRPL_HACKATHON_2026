import { cookies } from "next/headers";
import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { findSessionByToken, sessionCookieName, toHeaderSession, type AuthSession } from "./session";

/**
 * Current session for Server Components (layouts, pages). Owner: Agent A.
 * Memoised per request. Reading cookies makes the calling route dynamic.
 *
 * Fails closed: if the session store is unreachable the page renders signed out
 * instead of erroring. Route handlers should use `getRequestSession` /
 * `requireSession`, which surface the failure.
 */
export const getCurrentSession = cache(async (): Promise<AuthSession | null> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  try {
    return await findSessionByToken(getDb(), token);
  } catch (err) {
    console.error("[auth] session lookup failed; rendering as signed out", err);
    return null;
  }
});

export { toHeaderSession };
