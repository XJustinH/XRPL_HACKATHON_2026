import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ProfileVisibility } from "@/contracts";
import { SpotifyVisibility } from "@/contracts/integrations";

/**
 * Who may see a customer's now-playing status (XRPL-092).
 *
 * The preference lives in `User.settings.spotifyVisibility`, beside the other opt-ins
 * (`friendsVisibility`, `attendanceVisibility`). It is not a secret; the tokens are, and they are
 * stored elsewhere (SpotifyConnection).
 *
 * Private by default, and every new connection starts private again: connecting Spotify is one
 * decision and showing it to other people is a separate, later one.
 */

const KEY = "spotifyVisibility";

/** Anything missing or unparseable reads as ONLY_ME: a corrupt row must never read as shared. */
export function readSpotifyVisibility(settings: unknown): SpotifyVisibility {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[KEY] : undefined;
  const parsed = SpotifyVisibility.safeParse(raw);
  return parsed.success ? parsed.data : "ONLY_ME";
}

/**
 * Whether a viewer may see the owner's now-playing status.
 *
 * - The owner always sees their own.
 * - A blocked viewer (either direction) never does.
 * - ONLY_ME: nobody else. FRIENDS: accepted friends.
 * - EVERYONE: anyone, signed in or not, unless the profile is private, in which case it is
 *   accepted friends only, because a private profile is shown to nobody else.
 */
export function canViewNowPlaying(input: {
  visibility: SpotifyVisibility;
  profileVisibility: ProfileVisibility;
  viewerIsOwner: boolean;
  viewerIsFriend: boolean;
  viewerIsBlocked: boolean;
}): boolean {
  if (input.viewerIsOwner) return true;
  if (input.viewerIsBlocked) return false;
  if (input.visibility === "ONLY_ME") return false;
  if (input.visibility === "FRIENDS") return input.viewerIsFriend;
  return input.profileVisibility === "PUBLIC" ? true : input.viewerIsFriend;
}

type Db = Pick<PrismaClient, "user">;

export async function getSpotifyVisibility(db: Db, userId: string): Promise<SpotifyVisibility> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return readSpotifyVisibility(user?.settings);
}

/** Sets the caller's own preference, keeping every other key in `settings`. Null resets to private. */
export async function setSpotifyVisibility(db: Db, userId: string, value: SpotifyVisibility | null): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return;
  const next: Record<string, unknown> =
    user.settings && typeof user.settings === "object" && !Array.isArray(user.settings)
      ? { ...(user.settings as Record<string, unknown>) }
      : {};
  if (value === null) {
    if (!(KEY in next)) return;
    delete next[KEY];
  } else {
    next[KEY] = value;
  }
  await db.user.update({ where: { id: userId }, data: { settings: next as Prisma.InputJsonObject } });
}
