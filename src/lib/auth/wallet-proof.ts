import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// Pure codec/crypto helpers only: no ledger connection or wallet SDK is used here.
import { convertHexToString, decode, deriveAddress, verifySignature } from "xrpl";
import type { PrismaClient } from "@/generated/prisma/client";
import type { SignRequest, XrplNetwork } from "@/contracts";

/**
 * Wallet-control proof (XRPL-012). Owner: Agent A.
 *
 * A proof is a Xaman `SignIn` request that THIS server created (through Agent B's
 * adapter) and recorded in `WalletProof`. Verifying it requires all of:
 *  - binding: it only completes in the browser that started it (hashed httpOnly cookie token);
 *  - single use and a short expiry (atomic consume in the database);
 *  - Xaman reports the request SIGNED on our network (fetched server-to-server with our key);
 *  - the signed blob verifies locally: it is the non-submittable SignIn shape, its
 *    `xaman-signin` memo names this request, the signature is valid and the signing key
 *    derives to the reported account (master key);
 *  - if an address was requested, the signer is that address.
 */

export const WALLET_PROOF_TTL_MS = 10 * 60 * 1000; // Xaman's 5 min is "open before"; allow time to approve.
export const XAMAN_SIGNIN_MEMO_TYPE = "xaman-signin";

// ---------------------------------------------------------------------------
// Signed blob verification (pure)
// ---------------------------------------------------------------------------

export type BlobCheckFailure =
  | "MALFORMED"
  | "SUBMITTABLE_TX"
  | "MEMO_MISMATCH"
  | "BAD_SIGNATURE"
  | "ACCOUNT_MISMATCH"
  | "UNSUPPORTED_KEY";

export type BlobCheck = { ok: true } | { ok: false; reason: BlobCheckFailure };

const blobFail = (reason: BlobCheckFailure): BlobCheck => ({ ok: false, reason });

function hexToText(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9A-Fa-f]*$/.test(value)) return null;
  try {
    return convertHexToString(value);
  } catch {
    return null;
  }
}

/**
 * Verify a Xaman SignIn signed blob. Observed format (Xaman, Nov 2026): fields
 * `Account`, `SigningPubKey`, `TxnSignature` and one memo
 * `{ MemoType: "xaman-signin", MemoData: <payload uuid> }`; no TransactionType, so it can
 * never be submitted to the ledger. Regular-key and multi-signed blobs are not supported.
 */
export function verifyXamanSignInBlob(
  hex: string,
  expected: { signRequestId: string; account: string },
): BlobCheck {
  let tx: Record<string, unknown>;
  try {
    tx = decode(hex) as Record<string, unknown>;
  } catch {
    return blobFail("MALFORMED");
  }

  if ("TransactionType" in tx) return blobFail("SUBMITTABLE_TX");
  if ("Signers" in tx) return blobFail("UNSUPPORTED_KEY");
  const publicKey = tx.SigningPubKey;
  if (typeof publicKey !== "string" || publicKey.length === 0) return blobFail("UNSUPPORTED_KEY");

  const memos = tx.Memos;
  if (!Array.isArray(memos) || memos.length !== 1) return blobFail("MEMO_MISMATCH");
  const memo = (memos[0] as { Memo?: { MemoType?: unknown; MemoData?: unknown } } | undefined)?.Memo;
  if (
    hexToText(memo?.MemoType) !== XAMAN_SIGNIN_MEMO_TYPE ||
    hexToText(memo?.MemoData)?.toLowerCase() !== expected.signRequestId.toLowerCase()
  ) {
    return blobFail("MEMO_MISMATCH");
  }

  let signatureValid = false;
  try {
    signatureValid = verifySignature(hex);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return blobFail("BAD_SIGNATURE");

  if (tx.Account !== expected.account) return blobFail("ACCOUNT_MISMATCH");
  // The key must be the account's master key. Regular keys would need a ledger lookup.
  let derived: string | null = null;
  try {
    derived = deriveAddress(publicKey);
  } catch {
    derived = null;
  }
  if (derived !== expected.account) return blobFail("UNSUPPORTED_KEY");

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Proof requests (database + wallet provider)
// ---------------------------------------------------------------------------

/** What this module needs from the wallet provider. Agent B's `WalletSignRequests` satisfies it. */
export interface SignInProvider {
  createSignIn(): Promise<SignRequest>;
  getSignedSignIn(id: string): Promise<{ request: SignRequest; signedHex: string | null } | null>;
}

export type WalletProofFailure =
  | "NOT_FOUND"
  | "WRONG_BROWSER"
  | "EXPIRED"
  | "ALREADY_USED"
  | "NOT_SIGNED"
  | "INVALID_PROOF"
  | "WALLET_MISMATCH"
  | "UNSUPPORTED_KEY";

export type WalletProofResult =
  | { ok: true; address: string; proofId: string }
  | { ok: false; reason: WalletProofFailure };

type Db = Pick<PrismaClient, "walletProof">;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class WalletProofService {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    private readonly deps: {
      db: Db;
      /** Resolved lazily so a missing Xaman configuration fails per request, not at import. */
      provider: () => SignInProvider;
      network: XrplNetwork;
      now?: () => Date;
      ttlMs?: number;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? WALLET_PROOF_TTL_MS;
  }

  /** Start a sign-in. The returned `browserToken` must go into an httpOnly cookie. */
  async requestSignIn(input: {
    sessionId: string | null;
    requestedAddress?: string | null;
  }): Promise<{ signRequest: SignRequest; browserToken: string; expiresAt: Date }> {
    const signRequest = await this.deps.provider().createSignIn();
    const browserToken = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
    await this.deps.db.walletProof.create({
      data: {
        signRequestId: signRequest.id,
        network: this.deps.network,
        browserTokenHash: sha256Hex(browserToken),
        requestedAddress: input.requestedAddress ?? null,
        sessionId: input.sessionId,
        createdAt,
        expiresAt,
      },
    });
    return { signRequest, browserToken, expiresAt };
  }

  /**
   * Verify and consume a proof. Provider failures (Xaman unreachable, not configured)
   * are thrown, never reported as an invalid proof.
   */
  async verify(input: { signRequestId: string; browserToken: string | null }): Promise<WalletProofResult> {
    const fail = (reason: WalletProofFailure): WalletProofResult => ({ ok: false, reason });

    const proof = await this.deps.db.walletProof.findUnique({ where: { signRequestId: input.signRequestId } });
    if (!proof || proof.network !== this.deps.network) return fail("NOT_FOUND");
    if (!input.browserToken || !sameHash(proof.browserTokenHash, sha256Hex(input.browserToken))) {
      return fail("WRONG_BROWSER");
    }

    if (proof.consumedAt) return fail("ALREADY_USED");
    const now = this.now();
    if (proof.expiresAt <= now) return fail("EXPIRED");

    const signed = await this.deps.provider().getSignedSignIn(proof.signRequestId);
    if (!signed) return fail("NOT_SIGNED");
    const account = signed.request.account;
    if (!account || !signed.signedHex) return fail("INVALID_PROOF");

    const blob = verifyXamanSignInBlob(signed.signedHex, { signRequestId: proof.signRequestId, account });
    if (!blob.ok) return fail(blob.reason === "UNSUPPORTED_KEY" ? "UNSUPPORTED_KEY" : "INVALID_PROOF");

    if (proof.requestedAddress && proof.requestedAddress !== account) return fail("WALLET_MISMATCH");

    // Single use: only one concurrent verification can consume it.
    const { count } = await this.deps.db.walletProof.updateMany({
      where: { id: proof.id, consumedAt: null },
      data: { consumedAt: now, signerAddress: account },
    });
    if (count !== 1) return fail("ALREADY_USED");

    return { ok: true, address: account, proofId: proof.id };
  }
}
