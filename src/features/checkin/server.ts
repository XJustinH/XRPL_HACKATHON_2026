/**
 * Server-side wiring for the check-in routes. Server-only.
 *
 *  - Tickets, challenges, check-ins: Prisma.
 *  - XRPL ownership: Agent B's read service (XRPL-007), `verifyOwner`.
 *  - Wallet approval: Xaman SignIn through Agent B's sign requests (XRPL-011), see ./xaman-proof.ts.
 * Both external services are created on first use, so a missing XRPL or Xaman setting only makes
 * the step that needs it return 503, not every route.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { SignRequest } from "@/contracts/xrpl";
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { getXrplQueryService } from "@/lib/xrpl";
import { getWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";
import { CheckInService } from "./checkin-service";
import { EventSellerAccess } from "./organiser-access";
import { PrismaCheckInStore, PrismaTicketDirectory } from "./prisma-store";
import { XamanCheckInProofs } from "./xaman-proof";
import { XrplLedgerOwnership } from "./xrpl-ownership";

/** Creates a wallet sign-in for a challenge and the proof token bound to it. */
export type CheckInApproval = {
  createSignIn(): Promise<SignRequest>;
  tokenFor(challengeId: string, signInId: string): string;
};

type CheckInGlobal = {
  __checkinService?: CheckInService | null;
  __checkinApproval?: CheckInApproval | null;
  __checkinDevSecret?: string;
};
const g = globalThis as unknown as CheckInGlobal;

/**
 * QR signing key. CHECKIN_QR_SECRET if set; otherwise derived from SESSION_SECRET.
 * Outside production, falls back to a per-process random key (QRs stop working on restart).
 */
export function resolveQrSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CHECKIN_QR_SECRET;
  if (explicit) {
    if (Buffer.byteLength(explicit) < 32) throw errors.unavailable("Check-in is misconfigured");
    return explicit;
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) {
    return createHmac("sha256", env.SESSION_SECRET).update("checkin-qr-v1").digest("base64url");
  }
  if (env.NODE_ENV === "production") throw errors.unavailable("Check-in is not configured");
  g.__checkinDevSecret ??= randomBytes(32).toString("base64url");
  return g.__checkinDevSecret;
}

/** Separate key for proof tokens, so a QR tag can never double as a proof tag. */
const proofSecret = (qrSecret: string) => createHmac("sha256", qrSecret).update("checkin-proof-v1").digest("base64url");

function buildXamanProofs(): XamanCheckInProofs {
  return new XamanCheckInProofs(() => getWalletSignRequests(), proofSecret(resolveQrSecret()));
}

function buildCheckInService(): CheckInService {
  const db = getDb();
  return new CheckInService(
    {
      tickets: new PrismaTicketDirectory(db),
      organisers: new EventSellerAccess(db),
      ledger: new XrplLedgerOwnership({
        verifyOwner: (nftokenId, address) => getXrplQueryService().verifyOwner(nftokenId, address),
      }),
      proofs: buildXamanProofs(),
      store: new PrismaCheckInStore(db),
    },
    { qrSecret: resolveQrSecret() },
  );
}

export function getCheckInService(): CheckInService {
  g.__checkinService ??= buildCheckInService();
  return g.__checkinService;
}

export function getCheckInApproval(): CheckInApproval {
  if (!g.__checkinApproval) {
    const proofs = buildXamanProofs();
    g.__checkinApproval = {
      createSignIn: async () => {
        try {
          return await getWalletSignRequests().createSignIn();
        } catch {
          throw errors.unavailable("Could not reach Xaman to start the wallet approval. Try again.");
        }
      },
      tokenFor: (challengeId, signInId) => proofs.tokenFor(challengeId, signInId),
    };
  }
  return g.__checkinApproval;
}

/** Tests only: replace (or with null, reset) the service the routes use. */
export function setCheckInServiceForTests(service: CheckInService | null): void {
  g.__checkinService = service;
}
