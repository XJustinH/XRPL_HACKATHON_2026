import type { PrismaClient } from "@/generated/prisma/client";
import type { MeResponse } from "@/contracts";
import { toUserDto, toWalletLinkDto } from "@/lib/db/mappers";
import type { AuthSession } from "./session";

/** Body of GET/PATCH /api/me for the signed-in user. */
export async function loadMe(db: Pick<PrismaClient, "user">, session: AuthSession): Promise<MeResponse> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: session.userId },
    include: { wallets: { where: { revokedAt: null }, orderBy: { createdAt: "asc" } } },
  });
  return {
    user: toUserDto(user),
    wallets: user.wallets.map(toWalletLinkDto),
    session: { method: session.method, expiresAt: session.expiresAt.toISOString() },
  };
}
