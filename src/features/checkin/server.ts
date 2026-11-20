/**
 * Server-side wiring for the check-in routes. Server-only.
 *
 * Pieces that other agents have not delivered yet answer 503 instead of guessing:
 *  - wallet-control proof verification (XRPL-012)  -> `unavailableProofs`
 * Swap it in `buildCheckInService` once it lands.
 *
 * XRPL ownership uses Agent B's read service (XRPL-007). It is created lazily on the first
 * check, so a missing XRPL setting only makes ownership checks return 503, not every route.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getXrplQueryService } from "@/lib/xrpl";
import { errors } from "@/lib/http/response";
import { CheckInService } from "./checkin-service";
import { EventSellerAccess } from "./organiser-access";
import type { WalletProofVerifier } from "./ports";
import { PrismaCheckInStore, PrismaTicketDirectory } from "./prisma-store";
import { XrplLedgerOwnership } from "./xrpl-ownership";

const unavailableProofs: WalletProofVerifier = {
  async verify() {
    throw errors.unavailable("Wallet approval for check-in is not available yet");
  },
};

type CheckInGlobal = { __checkinService?: CheckInService | null; __checkinDevSecret?: string };
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

function buildCheckInService(): CheckInService {
  const db = getDb();
  return new CheckInService(
    {
      tickets: new PrismaTicketDirectory(db),
      organisers: new EventSellerAccess(db),
      ledger: new XrplLedgerOwnership({
        verifyOwner: (nftokenId, address) => getXrplQueryService().verifyOwner(nftokenId, address),
      }),
      proofs: unavailableProofs,
      store: new PrismaCheckInStore(db),
    },
    { qrSecret: resolveQrSecret() },
  );
}

export function getCheckInService(): CheckInService {
  g.__checkinService ??= buildCheckInService();
  return g.__checkinService;
}

/** Tests only: replace (or with null, reset) the service the routes use. */
export function setCheckInServiceForTests(service: CheckInService | null): void {
  g.__checkinService = service;
}
