import { EVENT_MANAGER_ROLES, ErrorCode, type UserRole } from "@/contracts";
import { AppError } from "@/lib/http/response";

/**
 * Who is acting, as the community features need it. An `AuthSession` satisfies it, so pages and
 * routes can pass the session straight in. Null means signed out.
 */
export type CommunityViewer = { userId: string; role: UserRole } | null;

/** Seller and organiser accounts: the only ones that may publish posts (XRPL-080). */
export const isSellerRole = (role: string): boolean => (EVENT_MANAGER_ROLES as readonly string[]).includes(role);

/**
 * Site moderators (XRPL-083). The schema has no admin role, so moderators are the account ids
 * listed in the server-only env var MODERATOR_USER_IDS (comma-separated). Read on every call, so
 * changing the list needs a restart at most, never a rebuild. Server-side only.
 */
export function isModerator(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return (process.env.MODERATOR_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .includes(userId.toLowerCase());
}

export const rateLimited = (message: string) => new AppError(ErrorCode.RATE_LIMITED, message, 429);

/** A short single-line preview of user text. */
export function excerpt(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
