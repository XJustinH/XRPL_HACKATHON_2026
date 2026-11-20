/**
 * Check-in wallet approval with Xaman SignIn (XRPL-045), using Agent B's sign requests (XRPL-011).
 *
 * Binding a sign-in to one check-in challenge, without storing anything extra:
 *  1. `POST /api/checkin/challenges/:id/sign-request` creates a Xaman SignIn and returns a proof
 *     token `<xamanRequestId>.<hmac(challengeId, xamanRequestId)>`.
 *  2. The attendee approves in Xaman, then submits that token to `.../prove`.
 *  3. `verify` checks the HMAC (this sign-in was created for this challenge), asks Xaman over our
 *     authenticated API whether it was SIGNED on the app's network and by which account, then verifies
 *     the signed blob locally with Agent A's `verifyXamanSignInBlob` (same rules as wallet sign-in,
 *     XRPL-012): memo names this request, signature valid, master key of the reported account.
 * An old sign-in (e.g. from /connect), or one made for another code, has no valid tag for this
 * challenge and is rejected. A SignIn moves no funds and is never submitted to the ledger.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyXamanSignInBlob } from "@/lib/auth/wallet-proof";
import { errors } from "@/lib/http/response";
import type { WalletProofVerifier } from "./ports";

/** The part of Agent B's `WalletSignRequests` this adapter needs. */
export type SignInSource = {
  getSignedSignIn(
    id: string,
  ): Promise<{ request: { account: string | null; networkMatches: boolean | null }; signedHex: string | null } | null>;
};

/** Agent A's pure blob check (src/lib/auth/wallet-proof.ts); injectable for tests. */
export type BlobVerifier = (hex: string, expected: { signRequestId: string; account: string }) => { ok: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;

export class XamanCheckInProofs implements WalletProofVerifier {
  constructor(
    private readonly signIns: () => SignInSource,
    private readonly secret: string,
    private readonly verifyBlob: BlobVerifier = verifyXamanSignInBlob,
  ) {}

  /** Proof token tying Xaman request `signInId` to `challengeId`. */
  tokenFor(challengeId: string, signInId: string): string {
    return `${signInId}.${this.tag(challengeId, signInId)}`;
  }

  async verify({ challengeId, proof }: { challengeId: string; proof: string }): Promise<string | null> {
    const [signInId = "", tag = "", ...rest] = proof.split(".");
    if (rest.length || !UUID_RE.test(signInId) || !TAG_RE.test(tag)) return null;
    if (!safeEqual(tag, this.tag(challengeId, signInId))) return null;

    let signed: Awaited<ReturnType<SignInSource["getSignedSignIn"]>>;
    try {
      signed = await this.signIns().getSignedSignIn(signInId);
    } catch (err) {
      if ((err as { code?: unknown }).code === "NOT_FOUND") return null;
      throw errors.unavailable("Could not reach Xaman to confirm the wallet approval. Try again.");
    }
    // getSignedSignIn only returns SIGNED requests on the app's network; check again anyway.
    if (!signed || signed.request.networkMatches !== true || !signed.request.account || !signed.signedHex) return null;
    // Don't take Xaman's word for the account: the signed blob itself must prove it.
    const blob = this.verifyBlob(signed.signedHex, { signRequestId: signInId, account: signed.request.account });
    return blob.ok ? signed.request.account : null;
  }

  private tag(challengeId: string, signInId: string): string {
    return createHmac("sha256", this.secret).update(`checkin-signin|v1|${challengeId}|${signInId.toLowerCase()}`).digest("base64url");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
