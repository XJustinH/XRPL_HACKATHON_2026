/**
 * Users and their privacy preferences for friendships (XRPL-084), on the existing User table.
 * `friendsVisibility` is kept in `User.settings` (non-sensitive preferences), defaulting to
 * ONLY_ME; profile visibility comes from the profile settings (XRPL-055/087).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { FriendsVisibility } from "@/contracts/friends";
import { readProfileSettings } from "@/features/profiles/profile-settings";
import type { DirectoryUser, UserDirectory } from "./friend-service";

type Db = Pick<PrismaClient, "user">;

export function readFriendsVisibility(settings: unknown): FriendsVisibility {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).friendsVisibility : undefined;
  const parsed = FriendsVisibility.safeParse(raw);
  return parsed.success ? parsed.data : "ONLY_ME";
}

export class PrismaUserDirectory implements UserDirectory {
  constructor(private readonly db: Db) {}

  async getUsers(ids: readonly string[]): Promise<Map<string, DirectoryUser>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true, settings: true },
    });
    return new Map(
      rows.map((u) => [
        u.id,
        {
          displayName: u.displayName,
          profileVisibility: readProfileSettings(u.settings).visibility,
          friendsVisibility: readFriendsVisibility(u.settings),
        },
      ]),
    );
  }

  async setFriendsVisibility(userId: string, value: FriendsVisibility): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { settings: true } });
    if (!user) return;
    const base = user.settings && typeof user.settings === "object" ? (user.settings as Record<string, unknown>) : {};
    await this.db.user.update({
      where: { id: userId },
      data: { settings: { ...base, friendsVisibility: value } as Prisma.InputJsonObject },
    });
  }
}
