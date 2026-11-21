import type { PrismaClient } from "@/generated/prisma/client";
import { EVENT_CATEGORY_LABELS, safeExternalUrl, type SocialLink } from "@/contracts";
import { getFriendService } from "@/features/friends/server";
import { readProfileSettings } from "./profile-settings";

/**
 * A customer's profile as seen by someone else (XRPL-087, XRPL-091).
 *
 * Visibility is decided here, once, and the shape returned differs by what the
 * viewer may see — rather than returning everything and trusting each component
 * to hide the right parts. A hidden profile returns no interests, no city and
 * no links at all, so there is nothing for a template to leak by accident.
 *
 * A PRIVATE profile is visible to the owner and to accepted friends. It is not
 * visible to a stranger, and never to a blocked viewer.
 */

type Db = Pick<PrismaClient, "user">;

export type PublicCustomerProfile = {
  userId: string;
  displayName: string;
  /** False when the viewer may not see the detail below. */
  visible: boolean;
  /** Why it is hidden, for honest copy rather than a blank page. */
  hiddenReason: "PRIVATE" | null;
  city: string | null;
  interestLabels: string[];
  /** Already filtered to safe schemes, so a template cannot render a bad href. */
  socialLinks: SocialLink[];
  isOwnProfile: boolean;
  isFriend: boolean;
};

export async function getPublicCustomerProfile(
  db: Db,
  input: { userId: string; viewerId: string | null },
): Promise<PublicCustomerProfile | null> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, displayName: true, settings: true },
  });
  if (!user) return null;

  const settings = readProfileSettings(user.settings);
  const isOwnProfile = input.viewerId === user.id;

  let isFriend = false;
  let isBlocked = false;
  if (!isOwnProfile && input.viewerId) {
    try {
      const service = getFriendService();
      isFriend = await service.areFriends(input.viewerId, user.id);
      // `areFriends` already accounts for blocking, but a blocked viewer must
      // not see a private profile even if that ever changes.
      isBlocked = !isFriend && (await service.areFriends(user.id, input.viewerId));
    } catch (error) {
      // Unknown friendship is treated as "not a friend": fail closed.
      console.error("[profiles] friendship check unavailable", error);
      isFriend = false;
    }
  }

  const visible =
    isOwnProfile || (settings.visibility === "PUBLIC" ? !isBlocked : isFriend && !isBlocked);

  if (!visible) {
    return {
      userId: user.id,
      displayName: user.displayName,
      visible: false,
      hiddenReason: "PRIVATE",
      city: null,
      interestLabels: [],
      socialLinks: [],
      isOwnProfile,
      isFriend,
    };
  }

  return {
    userId: user.id,
    displayName: user.displayName,
    visible: true,
    hiddenReason: null,
    city: settings.city,
    interestLabels: settings.interests.map((category) => EVENT_CATEGORY_LABELS[category]),
    // Re-checked here so a row stored before the scheme rule cannot reach an href.
    socialLinks: settings.socialLinks.flatMap((link) => {
      const url = safeExternalUrl(link.url);
      return url ? [{ label: link.label, url }] : [];
    }),
    isOwnProfile,
    isFriend,
  };
}
