import { cookies } from "next/headers";
import type { Session, SessionPort } from "@/features/integration/ports";
import { getDb } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import { errors } from "@/lib/http/response";
import { getCurrentSession } from "./current-session";
import { listDemoPersonas, startDemoSession } from "./onboarding";
import {
  findSessionByToken,
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
  type AuthSession,
} from "./session";

/**
 * Real implementation of the UI's `SessionPort` (src/features/integration/ports.ts)
 * for XRPL-010. `getSession` / `listPersonas` work anywhere on the server;
 * `setSession` writes cookies, so call it only from a Server Function or Route Handler.
 */

const toPortSession = (s: AuthSession): Session => ({
  userId: s.userId,
  displayName: s.displayName,
  role: s.role,
  walletAddress: s.walletAddress,
});

export const sessionPort: SessionPort = {
  async getSession() {
    const s = await getCurrentSession();
    return s ? toPortSession(s) : null;
  },

  /** Switch demo persona, or sign out with `null`. */
  async setSession(userId) {
    const store = await cookies();
    const db = getDb();
    const name = sessionCookieName();
    const token = store.get(name)?.value;
    const current = token ? await findSessionByToken(db, token) : null;

    if (userId === null) {
      if (current) await revokeSession(db, current.sessionId);
      store.delete(name);
      return null;
    }

    if (!getServerEnv().DEMO_LOGIN_ENABLED) throw errors.notFound("Demo persona not found");
    const started = await startDemoSession(db, userId, current);
    const { sameSite, ...opts } = sessionCookieOptions(started.expiresAt);
    store.set(name, started.token, { ...opts, sameSite: sameSite?.toLowerCase() as "lax" });
    const session = await findSessionByToken(db, started.token);
    return session ? toPortSession(session) : null;
  },

  async listPersonas() {
    if (!getServerEnv().DEMO_LOGIN_ENABLED) return [];
    const personas = await listDemoPersonas(getDb());
    return personas.map((p) => ({ ...p, walletAddress: null }));
  },
};
