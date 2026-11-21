import type { PrismaClient, User } from "@/generated/prisma/client";
import { AuthErrorCode, type XrplNetwork } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl";
import { getWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";
import { createSession, type AuthSession } from "./session";
import { WalletProofService, type WalletProofFailure } from "./wallet-proof";

/**
 * Wallet sign-in (XRPL-012). Owner: Agent A.
 * Turns a verified wallet proof into an account + session.
 * (Check-in wallet approval is Agent D's, in src/features/checkin/xaman-proof.ts.)
 */

const PROVIDER = "xaman-signin";

// ---------------------------------------------------------------------------
// Shared service
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __walletProofService?: WalletProofService };

/** Process-wide service. Xaman/XRPL config errors surface on use (mapped to 503 by routes). */
export function getWalletProofService(): WalletProofService {
  g.__walletProofService ??= new WalletProofService({
    db: getDb(),
    provider: () => getWalletSignRequests(),
    network: loadXrplConfig().network,
  });
  return g.__walletProofService;
}

/** Tests only. */
export function setWalletProofServiceForTests(service: WalletProofService | undefined): void {
  g.__walletProofService = service;
}

// ---------------------------------------------------------------------------
// Failures → API errors
// ---------------------------------------------------------------------------

const FAILURES: Record<WalletProofFailure, { code: string; status: number; message: string }> = {
  NOT_FOUND: { code: "NOT_FOUND", status: 404, message: "Wallet sign-in request not found." },
  WRONG_BROWSER: {
    code: AuthErrorCode.WALLET_PROOF_WRONG_BROWSER,
    status: 403,
    message: "This sign-in was started in a different browser. Start again here.",
  },
  EXPIRED: {
    code: AuthErrorCode.WALLET_PROOF_EXPIRED,
    status: 410,
    message: "This sign-in request expired. Start a new one.",
  },
  ALREADY_USED: {
    code: AuthErrorCode.WALLET_PROOF_ALREADY_USED,
    status: 409,
    message: "This sign-in request was already used. Start a new one.",
  },
  NOT_SIGNED: {
    code: AuthErrorCode.WALLET_PROOF_NOT_SIGNED,
    status: 409,
    message: "The request hasn't been approved in Xaman on the right network yet.",
  },
  INVALID_PROOF: {
    code: AuthErrorCode.WALLET_PROOF_INVALID,
    status: 401,
    message: "The wallet signature could not be verified.",
  },
  WALLET_MISMATCH: {
    code: AuthErrorCode.WALLET_MISMATCH,
    status: 403,
    message: "That request was signed by a different wallet than the one you asked to connect.",
  },
  UNSUPPORTED_KEY: {
    code: AuthErrorCode.WALLET_KEY_UNSUPPORTED,
    status: 422,
    message: "Accounts that sign with a regular key or multi-signing aren't supported yet.",
  },
};

export function walletProofError(reason: WalletProofFailure): AppError {
  const f = FAILURES[reason];
  return new AppError(f.code, f.message, f.status);
}

// ---------------------------------------------------------------------------
// Binding a proven wallet to an account and session
// ---------------------------------------------------------------------------

export type WalletSignInOutcome = {
  user: User;
  /** Set when a new session must be issued to the browser. */
  newSession?: { token: string; expiresAt: Date };
  newAccount: boolean;
  verifiedAt: Date;
};

/** Default name for a wallet-first account until the user picks one at /onboarding. */
export const walletDisplayName = (address: string) => `Wallet ${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * A wallet belongs to at most one account (WalletLink unique per network+address).
 *  - Signed in: link the wallet to the current account and mark this session as proven.
 *    If the wallet already belongs to another account → 409.
 *  - Signed out: sign in to the account that owns the wallet, or create a new account that
 *    still has to pick a role (`onboardedAt` null).
 */
export async function completeWalletSignIn(
  db: Pick<PrismaClient, "$transaction">,
  input: {
    current: AuthSession | null;
    address: string;
    network: XrplNetwork;
    signRequestId: string;
    now?: Date;
  },
): Promise<WalletSignInOutcome> {
  const now = input.now ?? new Date();
  const { address, network, signRequestId, current } = input;

  return db.$transaction(async (tx) => {
    const link = await tx.walletLink.findUnique({ where: { network_address: { network, address } } });
    const ownerId = link && !link.revokedAt && link.verifiedAt ? link.userId : null;

    let userId: string;
    let newAccount = false;
    if (current) {
      if (ownerId && ownerId !== current.userId) {
        throw new AppError(
          AuthErrorCode.WALLET_LINKED_TO_OTHER_ACCOUNT,
          "This wallet is linked to another account, so it can't be added to this one. Pick a different account in Xaman and try again, or sign out and connect to use the wallet's own account.",
          409,
        );
      }
      userId = current.userId;
    } else if (ownerId) {
      userId = ownerId;
    } else {
      const user = await tx.user.create({ data: { displayName: walletDisplayName(address) } });
      userId = user.id;
      newAccount = true;
    }

    const linkData = {
      userId,
      verifiedAt: now,
      verificationProvider: PROVIDER,
      verificationRef: signRequestId,
      revokedAt: null,
    };
    await tx.walletLink.upsert({
      where: { network_address: { network, address } },
      create: { network, address, ...linkData },
      update: linkData,
    });

    let newSession: WalletSignInOutcome["newSession"];
    if (current) {
      await tx.session.update({
        where: { id: current.sessionId },
        data: { walletAddress: address, walletVerifiedAt: now },
      });
    } else {
      const created = await createSession(tx, userId, "WALLET", now, { address });
      newSession = { token: created.token, expiresAt: created.expiresAt };
    }

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    return { user, newSession, newAccount, verifiedAt: now };
  });
}

