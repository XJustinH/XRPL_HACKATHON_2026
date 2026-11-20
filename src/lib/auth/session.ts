import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { SessionMethod, UserRole } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { parseCookieHeader, serializeCookie, type CookieOptions } from "./cookies";

/**
 * Server-side sessions (XRPL-010). Owner: Agent A.
 *
 * - The cookie carries a random 256-bit token (base64url). Only SHA-256(token) is
 *   stored, so a database read never yields a usable cookie.
 * - Cookies are HttpOnly + SameSite=Lax, and Secure (with the `__Host-` prefix) when
 *   APP_BASE_URL is https. Mutations are additionally same-origin checked by
 *   `withApiHandler`.
 * - A session does NOT prove wallet control by itself. `walletAddress` comes only from a
 *   wallet-signed proof verified by the server (XRPL-012, see wallet-proof.ts).
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

export type AuthSession = {
  sessionId: string;
  userId: string;
  displayName: string;
  role: UserRole;
  /** Null until the user has chosen a role (possible for wallet-first accounts, XRPL-012). */
  onboardedAt: Date | null;
  isDemo: boolean;
  method: SessionMethod;
  expiresAt: Date;
  /**
   * The account's proven wallet (XRPL-012): proven in this session, or (real accounts only)
   * verified earlier and still linked. Demo personas count only a proof made in this session.
   * Null means wallet control is not proven.
   */
  walletAddress: string | null;
  walletVerifiedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Tokens and cookies
// ---------------------------------------------------------------------------

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Secure cookies whenever the app is served over https. */
export function cookieIsSecure(): boolean {
  try {
    return new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").protocol === "https:";
  } catch {
    return false;
  }
}

/** `__Host-` binds the cookie to this exact origin; browsers only accept it with Secure. */
export function sessionCookieName(secure = cookieIsSecure()): string {
  return secure ? "__Host-xt_session" : "xt_session";
}

export function sessionCookieOptions(expiresAt: Date, secure = cookieIsSecure()): CookieOptions {
  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  };
}

export function sessionSetCookie(token: string, expiresAt: Date): string {
  return serializeCookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
}

export function sessionClearCookie(): string {
  return serializeCookie(sessionCookieName(), "", {
    ...sessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
}

/** Session token from a request's Cookie header, or null. */
export function readSessionToken(req: Request): string | null {
  return parseCookieHeader(req.headers.get("cookie")).get(sessionCookieName()) ?? null;
}

// Wallet sign-in binding cookie (XRPL-012): ties a wallet proof to the browser that started it.
// Scoped to /api/auth so it is only sent to the challenge/verify endpoints.
const WALLET_PROOF_COOKIE_PATH = "/api/auth";

export function walletProofCookieName(secure = cookieIsSecure()): string {
  return secure ? "__Secure-xt_wallet_proof" : "xt_wallet_proof";
}

export function walletProofSetCookie(token: string, expiresAt: Date): string {
  return serializeCookie(walletProofCookieName(), token, {
    ...sessionCookieOptions(expiresAt),
    path: WALLET_PROOF_COOKIE_PATH,
  });
}

export function walletProofClearCookie(): string {
  return serializeCookie(walletProofCookieName(), "", {
    ...sessionCookieOptions(new Date(0)),
    path: WALLET_PROOF_COOKIE_PATH,
    maxAge: 0,
  });
}

export function readWalletProofToken(req: Request): string | null {
  return parseCookieHeader(req.headers.get("cookie")).get(walletProofCookieName()) ?? null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function createSession(
  db: Pick<PrismaClient, "session">,
  userId: string,
  method: SessionMethod,
  now = new Date(),
  /** Only for a session established by a just-verified wallet proof (XRPL-012). */
  provenWallet?: { address: string },
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const row = await db.session.create({
    data: {
      userId,
      method,
      tokenHash: hashSessionToken(token),
      createdAt: now,
      expiresAt,
      walletAddress: provenWallet?.address ?? null,
      walletVerifiedAt: provenWallet ? now : null,
    },
  });
  return { token, expiresAt, sessionId: row.id };
}

/** Resolve a cookie token to a live session. Unknown, malformed, revoked or expired → null. */
export async function findSessionByToken(
  db: Pick<PrismaClient, "session">,
  token: string,
  now = new Date(),
): Promise<AuthSession | null> {
  if (!TOKEN_FORMAT.test(token)) return null;
  const row = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      user: {
        include: {
          wallets: {
            where: { verifiedAt: { not: null }, revokedAt: null },
            orderBy: { verifiedAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });
  if (!row || row.revokedAt || row.expiresAt <= now) return null;

  // A proof made in this session wins. Otherwise a real account keeps its verified, still-linked
  // wallet (the XRPL-010 contract). A shared demo persona never inherits someone else's proof.
  const linked = row.user.isDemo ? undefined : row.user.wallets[0];
  return {
    sessionId: row.id,
    userId: row.userId,
    displayName: row.user.displayName,
    role: row.user.role,
    onboardedAt: row.user.onboardedAt,
    isDemo: row.user.isDemo,
    method: row.method,
    expiresAt: row.expiresAt,
    walletAddress: row.walletAddress ?? linked?.address ?? null,
    walletVerifiedAt: row.walletVerifiedAt ?? linked?.verifiedAt ?? null,
  };
}

export async function revokeSession(db: Pick<PrismaClient, "session">, sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Route handler helpers
// ---------------------------------------------------------------------------

export async function getRequestSession(
  req: Request,
  db: Pick<PrismaClient, "session"> = getDb(),
): Promise<AuthSession | null> {
  const token = readSessionToken(req);
  return token ? findSessionByToken(db, token) : null;
}

/** 401 UNAUTHENTICATED unless the request carries a live session. Role checks are XRPL-013. */
export async function requireSession(
  req: Request,
  db: Pick<PrismaClient, "session"> = getDb(),
): Promise<AuthSession> {
  const session = await getRequestSession(req, db);
  if (!session) throw errors.unauthenticated();
  return session;
}

/** Shape consumed by the site header (`HeaderSession` in src/components/site-header.tsx). */
export function toHeaderSession(s: AuthSession): {
  displayName: string;
  role: UserRole;
  walletAddress: string | null;
} {
  return { displayName: s.displayName, role: s.role, walletAddress: s.walletAddress };
}
