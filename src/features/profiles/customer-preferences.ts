import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { CustomerProfilePatch, EventCategory } from "@/contracts";
import { mergeProfileSettings, readProfileSettings } from "./profile-settings";

/**
 * Declared discovery preferences (XRPL-058).
 *
 * Opt-in by design: an account with none set is a supported, normal state, and
 * every browsing surface must work without them. Only a city the customer typed
 * is stored — never a precise or device-derived location.
 */

type PreferencesDb = Pick<PrismaClient, "user">;

export type CustomerPreferences = {
  interests: EventCategory[];
  city: string | null;
  /** False when nothing has been chosen, so callers can offer the prompt once. */
  hasPreferences: boolean;
};

export async function getCustomerPreferences(
  db: PreferencesDb,
  userId: string,
): Promise<CustomerPreferences> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = readProfileSettings(user?.settings);
  return {
    interests: settings.interests,
    city: settings.city,
    hasPreferences: settings.interests.length > 0 || settings.city !== null,
  };
}

/**
 * Saves or clears a customer's preferences.
 *
 * An empty interest list and an empty city are both meaningful: they are how
 * the UI expresses "clear these", which the issue requires alongside editing.
 */
export async function updateCustomerPreferences(
  db: PreferencesDb,
  userId: string,
  patch: Pick<CustomerProfilePatch, "interests" | "city">,
): Promise<CustomerPreferences> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });

  const settings = mergeProfileSettings(user?.settings, {
    ...(patch.interests !== undefined ? { interests: patch.interests } : {}),
    ...(patch.city !== undefined ? { city: patch.city } : {}),
  });

  await db.user.update({
    where: { id: userId },
    data: { settings: settings as Prisma.InputJsonObject },
  });

  return getCustomerPreferences(db, userId);
}
