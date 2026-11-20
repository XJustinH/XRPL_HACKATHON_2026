import { z } from "zod";
import { AppId, IsoDateTime, XrplAddress } from "./common";
import { UserDto, UserRole, WalletLinkDto, XrplNetwork } from "./entities";

/**
 * Sessions, onboarding, account, wallet sign-in and permission contracts. Owner: Agent A.
 * XRPL-010 (sessions, onboarding), XRPL-012 (wallet-control proof), XRPL-013 (permissions).
 */

/** Error codes specific to this slice (cross-cutting codes live in common.ts). */
export const AuthErrorCode = {
  /** 409: the account already chose a role. */
  ALREADY_ONBOARDED: "ALREADY_ONBOARDED",
  /** 403: role changes are not self-service. */
  ROLE_CHANGE_FORBIDDEN: "ROLE_CHANGE_FORBIDDEN",
  /** 403: the wallet sign-in was started in a different browser. */
  WALLET_PROOF_WRONG_BROWSER: "WALLET_PROOF_WRONG_BROWSER",
  /** 410: the wallet sign-in request expired; start a new one. */
  WALLET_PROOF_EXPIRED: "WALLET_PROOF_EXPIRED",
  /** 409: the wallet sign-in request was already used. */
  WALLET_PROOF_ALREADY_USED: "WALLET_PROOF_ALREADY_USED",
  /** 409: the request is not signed (still open, declined, or signed on another network). */
  WALLET_PROOF_NOT_SIGNED: "WALLET_PROOF_NOT_SIGNED",
  /** 401: the signature could not be verified. */
  WALLET_PROOF_INVALID: "WALLET_PROOF_INVALID",
  /** 403: signed by a different wallet than the one requested. */
  WALLET_MISMATCH: "WALLET_MISMATCH",
  /** 422: regular-key or multi-signed accounts are not supported yet. */
  WALLET_KEY_UNSUPPORTED: "WALLET_KEY_UNSUPPORTED",
  /** 409: the wallet already belongs to another account. */
  WALLET_LINKED_TO_OTHER_ACCOUNT: "WALLET_LINKED_TO_OTHER_ACCOUNT",
  // --- Permissions (XRPL-013) ---
  /** 403: the account has not chosen a role yet (finish /onboarding). */
  ONBOARDING_REQUIRED: "ONBOARDING_REQUIRED",
  /** 403: the account's role may not do this (e.g. a customer creating an event). */
  ROLE_REQUIRED: "ROLE_REQUIRED",
  /** 403: only the event's owner may do this. */
  NOT_EVENT_OWNER: "NOT_EVENT_OWNER",
  /** 403: no wallet is proven for this session (connect with Xaman first). */
  WALLET_NOT_VERIFIED: "WALLET_NOT_VERIFIED",
  /** 403: the proven wallet does not hold this ticket on a validated ledger. */
  NOT_TICKET_OWNER: "NOT_TICKET_OWNER",
  /** 409: the ticket has no validated mint yet, so it has no on-chain owner. */
  TICKET_NOT_MINTED: "TICKET_NOT_MINTED",
} as const;

/**
 * Roles that may create and manage events (and run their gate scanner). Shared with the UI so
 * navigation and server checks agree; the server check is what counts.
 */
export const EventManagerRole = UserRole.extract(["SELLER", "ORGANISER"]);
export type EventManagerRole = z.infer<typeof EventManagerRole>;
export const EVENT_MANAGER_ROLES: readonly EventManagerRole[] = EventManagerRole.options;

/** How a session was established. Mirrors the Prisma `SessionMethod` enum. */
export const SessionMethod = z.enum(["ONBOARDING", "DEMO_PERSONA", "WALLET"]);
export type SessionMethod = z.infer<typeof SessionMethod>;

/**
 * Roles a visitor may pick for themselves. ORGANISER (an event manager like SELLER) is never
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
  /** Wallet whose control was proven in this session (XRPL-012); null if none. */
  walletAddress: XrplAddress.nullable(),
  walletVerifiedAt: IsoDateTime.nullable(),
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

// ---------------------------------------------------------------------------
// Wallet sign-in (XRPL-012)
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/challenge — start a wallet sign-in. `kind` is accepted so the wallet
 * UI can send the same body it sends to /api/wallet/sign-requests. With `address`, only
 * that wallet may complete the proof (WALLET_MISMATCH otherwise).
 * 201 { data: SignRequest } (src/contracts/xrpl.ts) + an httpOnly binding cookie.
 */
export const WalletChallengeRequest = z
  .object({
    kind: z.literal("SIGN_IN").optional(),
    address: XrplAddress.optional(),
  })
  .strict();
export type WalletChallengeRequest = z.infer<typeof WalletChallengeRequest>;

/** POST /api/auth/verify — complete a signed wallet sign-in from the same browser. */
export const WalletVerifyRequest = z.object({ signRequestId: z.uuid() }).strict();
export type WalletVerifyRequest = z.infer<typeof WalletVerifyRequest>;

export const VerifiedWallet = z.object({
  address: XrplAddress,
  network: XrplNetwork,
  verifiedAt: IsoDateTime,
});
export type VerifiedWallet = z.infer<typeof VerifiedWallet>;

/** 201 when a new wallet-first account was created, 200 otherwise. */
export const WalletVerifyResponse = z.object({
  user: UserDto,
  wallet: VerifiedWallet,
  /** True until the user picks a role at /onboarding. */
  needsOnboarding: z.boolean(),
  newAccount: z.boolean(),
});
export type WalletVerifyResponse = z.infer<typeof WalletVerifyResponse>;

/** POST /api/auth/logout — body optional. `forgetWallet` also unlinks this session's wallet. */
export const LogoutRequest = z.object({ forgetWallet: z.boolean().optional() }).strict();
export type LogoutRequest = z.infer<typeof LogoutRequest>;
