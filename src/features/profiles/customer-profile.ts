import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { safeExternalUrl, type CustomerProfilePatch, type UserRole } from "@/contracts";
import { mergeProfileSettings, readProfileSettings } from "./profile-settings";
import { ProfileNotFoundError } from "./profile-store";

/**
 * A signed-in customer's own profile (XRPL-056): display name and avatar.
 *
 * `displayName` lives on the User row; the avatar is `imageUrl` in `User.settings`, the same field
 * the seller profile uses for its image (see `./profile-settings`). Other preferences in settings
 * (city, interests, seller fields) are preserved on every write.
 */

type ProfileDb = Pick<PrismaClient, "user">;

export type OwnCustomerProfile = {
  id: string;
  displayName: string;
  role: UserRole;
  /** Only an http(s) URL is ever returned; anything else stored reads as null. */
  imageUrl: string | null;
  joinedAt: string;
};

export type OwnProfilePatch = Pick<CustomerProfilePatch, "displayName" | "imageUrl">;

export async function getOwnCustomerProfile(db: ProfileDb, userId: string): Promise<OwnCustomerProfile> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, role: true, settings: true, createdAt: true },
  });
  if (!user) throw new ProfileNotFoundError("Profile not found");
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    imageUrl: safeExternalUrl(readProfileSettings(user.settings).imageUrl),
    joinedAt: user.createdAt.toISOString(),
  };
}

/** Edits the caller's own name and avatar. An empty `imageUrl` removes the avatar. */
export async function updateOwnCustomerProfile(
  db: ProfileDb,
  userId: string,
  patch: OwnProfilePatch,
): Promise<OwnCustomerProfile> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) throw new ProfileNotFoundError("Profile not found");

  const data: Prisma.UserUpdateInput = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.imageUrl !== undefined) {
    data.settings = mergeProfileSettings(user.settings, { imageUrl: patch.imageUrl }) as Prisma.InputJsonObject;
  }
  if (Object.keys(data).length > 0) await db.user.update({ where: { id: userId }, data });
  return getOwnCustomerProfile(db, userId);
}
