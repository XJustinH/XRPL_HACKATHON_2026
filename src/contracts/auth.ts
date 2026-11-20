import { z } from "zod";
import { AppId, IsoDateTime } from "./common";
import { UserDto, UserRole, WalletLinkDto } from "./entities";

/**
 * Sessions, onboarding and account contracts (XRPL-010). Owner: Agent A.
 * Wallet-control proof (XRPL-012) and role enforcement (XRPL-013) extend this slice.
 */

/** Error codes specific to this slice (cross-cutting codes live in common.ts). */
export const AuthErrorCode = {
  /** 409: the account already chose a role. */
  ALREADY_ONBOARDED: "ALREADY_ONBOARDED",
  /** 403: role changes are not self-service. */
  ROLE_CHANGE_FORBIDDEN: "ROLE_CHANGE_FORBIDDEN",
} as const;

/** How a session was established. Mirrors the Prisma `SessionMethod` enum. */
export const SessionMethod = z.enum(["ONBOARDING", "DEMO_PERSONA"]);
export type SessionMethod = z.infer<typeof SessionMethod>;

/**
 * Roles a visitor may pick for themselves. ORGANISER (gate staff) is never
 * self-service: it is assigned through seeded demo accounts or an admin path.
 */
export const SelfServeRole = UserRole.extract(["CUSTOMER", "SELLER"]);
export type SelfServeRole = z.infer<typeof SelfServeRole>;

/** Trimmed, 2–80 visible characters, no control characters. */
export const DisplayName = z
  .string()
  .trim()
  .min(2, "Display name must be at least 2 characters")
  .max(80, "Display name must be 80 characters or fewer")
  .regex(/^[^\p{Cc}]+$/u, "Display name cannot contain control characters");
export type DisplayName = z.infer<typeof DisplayName>;

// ---------------------------------------------------------------------------
// POST /api/onboarding
// ---------------------------------------------------------------------------

export const OnboardingRequest = z
  .object({
    displayName: DisplayName,
    role: SelfServeRole,
  })
  .strict();
export type OnboardingRequest = z.infer<typeof OnboardingRequest>;

/** 201 when a new account was created, 200 when an existing session finished onboarding. */
export const OnboardingResponse = z.object({ user: UserDto });
export type OnboardingResponse = z.infer<typeof OnboardingResponse>;

// ---------------------------------------------------------------------------
// GET / PATCH /api/me
// ---------------------------------------------------------------------------

export const SessionInfo = z.object({
  method: SessionMethod,
  expiresAt: IsoDateTime,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const MeResponse = z.object({
  user: UserDto,
  /** Linked addresses. `verifiedAt: null` means control has NOT been proven. */
  wallets: z.array(WalletLinkDto),
  session: SessionInfo,
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * Self-service profile fields only. `role` is deliberately absent: a request that
 * includes it is rejected with 403 rather than silently ignored.
 */
export const UpdateMeRequest = z
  .object({ displayName: DisplayName })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

// ---------------------------------------------------------------------------
// Demo personas (hackathon demo only; disabled with DEMO_LOGIN_ENABLED=false)
// ---------------------------------------------------------------------------

export const DemoPersona = z.object({
  userId: AppId,
  displayName: z.string(),
  role: UserRole,
});
export type DemoPersona = z.infer<typeof DemoPersona>;

/** GET /api/auth/demo-personas */
export const DemoPersonasResponse = z.object({
  enabled: z.boolean(),
  personas: z.array(DemoPersona),
});
export type DemoPersonasResponse = z.infer<typeof DemoPersonasResponse>;

/** POST /api/auth/demo-session */
export const DemoSessionRequest = z.object({ userId: AppId }).strict();
export type DemoSessionRequest = z.infer<typeof DemoSessionRequest>;
