import type { PrismaClient, User } from "@/generated/prisma/client";
import { AuthErrorCode, type DemoPersona, type OnboardingRequest } from "@/contracts";
import { AppError, errors } from "@/lib/http/response";
import { createSession, revokeSession, type AuthSession } from "./session";

/**
 * Customer / seller onboarding and demo personas (XRPL-010). Owner: Agent A.
 * Route handlers stay thin; these functions hold the rules.
 */

type Db = Pick<PrismaClient, "user" | "session" | "$transaction">;

export type OnboardingResult = {
  user: User;
  /** True when a new account was created (201), false when an existing session finished onboarding (200). */
  created: boolean;
  /** Present only when a new session must be issued to the browser. */
  newSession?: { token: string; expiresAt: Date };
};

const alreadyOnboarded = () =>
  new AppError(
    AuthErrorCode.ALREADY_ONBOARDED,
    "This account has already chosen a role. Role changes are not self-service.",
    409,
  );

/**
 * Choose a role. Without a session a new account + session is created. With a session
 * whose user has not chosen a role yet (a wallet-first account from XRPL-012), that
 * user is completed in place. A role is chosen once: repeats are 409.
 */
export async function onboard(
  db: Db,
  current: AuthSession | null,
  input: OnboardingRequest,
  now = new Date(),
): Promise<OnboardingResult> {
  if (current) {
    if (current.onboardedAt) throw alreadyOnboarded();
    // Conditional update: two concurrent submissions cannot both set a role.
    const { count } = await db.user.updateMany({
      where: { id: current.userId, onboardedAt: null },
      data: { role: input.role, displayName: input.displayName, onboardedAt: now },
    });
    if (count === 0) throw alreadyOnboarded();
    const user = await db.user.findUniqueOrThrow({ where: { id: current.userId } });
    return { user, created: false };
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { role: input.role, displayName: input.displayName, onboardedAt: now },
    });
    const { token, expiresAt } = await createSession(tx, user.id, "ONBOARDING", now);
    return { user, created: true, newSession: { token, expiresAt } };
  });
}

/** Seeded demo personas (XRPL-008 marks them `isDemo`). Caller checks DEMO_LOGIN_ENABLED. */
export async function listDemoPersonas(db: Pick<PrismaClient, "user">, limit = 20): Promise<DemoPersona[]> {
  const users = await db.user.findMany({
    where: { isDemo: true },
    orderBy: [{ role: "asc" }, { displayName: "asc" }],
    take: limit,
    select: { id: true, displayName: true, role: true },
  });
  return users.map((u) => ({ userId: u.id, displayName: u.displayName, role: u.role }));
}

/**
 * Sign in as a demo persona, replacing any current session. Non-demo accounts are
 * reported as not found so this endpoint cannot be used to probe real users.
 * Caller checks DEMO_LOGIN_ENABLED.
 */
export async function startDemoSession(
  db: Db,
  userId: string,
  current: AuthSession | null,
): Promise<{ user: User; token: string; expiresAt: Date }> {
  const user = await db.user.findFirst({ where: { id: userId, isDemo: true } });
  if (!user) throw errors.notFound("Demo persona not found");
  if (current) await revokeSession(db, current.sessionId);
  const { token, expiresAt } = await createSession(db, user.id, "DEMO_PERSONA");
  return { user, token, expiresAt };
}
