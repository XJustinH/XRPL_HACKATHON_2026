import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SignRequest } from "@/contracts";
import { POST as challengePOST } from "@/app/api/auth/challenge/route";
import { POST as demoSessionPOST } from "@/app/api/auth/demo-session/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as verifyPOST } from "@/app/api/auth/verify/route";
import { GET as meGET } from "@/app/api/me/route";
import { POST as onboardingPOST } from "@/app/api/onboarding/route";
import { getDb } from "@/lib/db/client";
import { XrplServiceError } from "@/lib/xrpl";
import { createSession, findSessionByToken, hashSessionToken } from "./session";
import { makeSignInBlob, newTestKey, type TestKey } from "./testing/signin-blob";
import { WalletProofService, type SignInProvider } from "./wallet-proof";
import { setWalletProofServiceForTests } from "./wallet-sign-in";

/**
 * XRPL-012 through the real route handlers against Postgres, with a fake Xaman.
 * Blobs are real Ed25519 signatures in Xaman's SignIn format (see testing/signin-blob.ts).
 */

const db = getDb();
const ORIGIN = "http://localhost:3000";
const ctx = {} as never;

// ---------------------------------------------------------------------------
// Fake wallet provider
// ---------------------------------------------------------------------------

type FakeEntry = { signed?: { key: TestKey; blob: string }; wrongNetwork?: boolean };

class FakeXaman implements SignInProvider {
  entries = new Map<string, FakeEntry>();
  failWith: Error | null = null;

  async createSignIn(): Promise<SignRequest> {
    if (this.failWith) throw this.failWith;
    const id = randomUUID();
    this.entries.set(id, {});
    return this.view(id);
  }

  async getSignedSignIn(id: string) {
    if (this.failWith) throw this.failWith;
    const entry = this.entries.get(id);
    if (!entry?.signed || entry.wrongNetwork) return null;
    return { request: this.view(id), signedHex: entry.signed.blob };
  }

  /** The user approves request `id` in Xaman with `key` (optionally signing a different request's memo). */
  approve(id: string, key: TestKey, opts: { memoFor?: string } = {}) {
    const blob = makeSignInBlob({ signRequestId: opts.memoFor ?? id, key });
    this.entries.set(id, { ...this.entries.get(id), signed: { key, blob } });
  }

  private view(id: string): SignRequest {
    const signed = this.entries.get(id)?.signed;
    return {
      id,
      kind: "SIGN_IN",
      status: signed ? "SIGNED" : "PENDING",
      signUrl: `https://xumm.app/sign/${id}`,
      qrPngUrl: `https://xumm.app/sign/${id}_q.png`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      account: signed ? signed.key.address : null,
      walletNetwork: signed ? "TESTNET" : null,
      networkMatches: signed ? true : null,
    };
  }
}

let xaman: FakeXaman;

// ---------------------------------------------------------------------------
// HTTP helpers (a tiny cookie jar per "browser")
// ---------------------------------------------------------------------------

class Browser {
  cookies = new Map<string, string>();

  req(path: string, init: { method?: string; body?: unknown } = {}): Request {
    const headers = new Headers({ origin: ORIGIN });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    return new Request(`${ORIGIN}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  absorb(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (/Max-Age=0/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async challenge(body: unknown = { kind: "SIGN_IN" }) {
    const res = this.absorb(await challengePOST(this.req("/api/auth/challenge", { method: "POST", body }), ctx));
    return { res, body: await res.json() };
  }

  async verify(signRequestId: string) {
    const res = this.absorb(await verifyPOST(this.req("/api/auth/verify", { method: "POST", body: { signRequestId } }), ctx));
    return { res, body: await res.json() };
  }

  sessionToken(): string | undefined {
    return this.cookies.get("xt_session");
  }
}

/** Full happy path in one browser: challenge → user approves with `key` → verify. */
async function signInWith(browser: Browser, key: TestKey) {
  const { body } = await browser.challenge();
  xaman.approve(body.data.id, key);
  return browser.verify(body.data.id);
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
  xaman = new FakeXaman();
  setWalletProofServiceForTests(new WalletProofService({ db, provider: () => xaman, network: "TESTNET" }));
});

afterAll(async () => {
  setWalletProofServiceForTests(undefined);
  await db.$disconnect();
});

// ---------------------------------------------------------------------------

describe("POST /api/auth/challenge", () => {
  it("issues a one-time, expiring request bound to this browser", async () => {
    const browser = new Browser();
    const { res, body } = await browser.challenge();
    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ kind: "SIGN_IN", status: "PENDING" });

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("xt_wallet_proof="))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Path=\/api\/auth/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    const proof = await db.walletProof.findUniqueOrThrow({ where: { signRequestId: body.data.id } });
    expect(proof.network).toBe("TESTNET");
    expect(proof.browserTokenHash).toBe(hashSessionToken(browser.cookies.get("xt_wallet_proof")!));
    expect(proof.consumedAt).toBeNull();
    expect(proof.expiresAt.getTime() - proof.createdAt.getTime()).toBe(10 * 60_000);
  });

  it("answers 503 when the wallet provider is not configured", async () => {
    xaman.failWith = new XrplServiceError("CONFIG_ERROR", "Wallet signing is not configured");
    const { res, body } = await new Browser().challenge();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(await db.walletProof.count()).toBe(0);
  });

  it("rejects cross-origin requests", async () => {
    const req = new Request(`${ORIGIN}/api/auth/challenge`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect((await challengePOST(req, ctx)).status).toBe(403);
  });
});

describe("POST /api/auth/verify — signed out", () => {
  it("creates a wallet-first account whose session has proven the wallet", async () => {
    const key = newTestKey();
    const browser = new Browser();
    const { res, body } = await signInWith(browser, key);

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ newAccount: true, needsOnboarding: true });
    expect(body.data.wallet).toMatchObject({ address: key.address, network: "TESTNET" });
    expect(browser.cookies.has("xt_wallet_proof")).toBe(false); // binding cookie cleared

    const session = await findSessionByToken(db, browser.sessionToken()!);
    expect(session).toMatchObject({ method: "WALLET", walletAddress: key.address, onboardedAt: null });
    const link = await db.walletLink.findFirstOrThrow();
    expect(link).toMatchObject({ address: key.address, userId: session!.userId, verificationProvider: "xaman-signin" });
    expect(link.verifiedAt).not.toBeNull();

    const me = await (await meGET(browser.req("/api/me"), ctx)).json();
    expect(me.data.session).toMatchObject({ method: "WALLET", walletAddress: key.address });
  });

  it("signs a returning wallet into its existing account", async () => {
    const key = newTestKey();
    const first = await signInWith(new Browser(), key);
    const again = await signInWith(new Browser(), key);
    expect(again.res.status).toBe(200);
    expect(again.body.data.newAccount).toBe(false);
    expect(again.body.data.user.id).toBe(first.body.data.user.id);
    expect(await db.user.count()).toBe(1);
  });

  it("lets the wallet-first account then pick its role at /onboarding", async () => {
    const browser = new Browser();
    await signInWith(browser, newTestKey());
    const res = await onboardingPOST(
      browser.req("/api/onboarding", { method: "POST", body: { displayName: "Niamh", role: "SELLER" } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.user).toMatchObject({ role: "SELLER", displayName: "Niamh" });
  });
});

describe("POST /api/auth/verify — rejections", () => {
  it("refuses a replay of an already used request", async () => {
    const key = newTestKey();
    const browser = new Browser();
    const { body } = await browser.challenge();
    xaman.approve(body.data.id, key);
    const token = browser.cookies.get("xt_wallet_proof")!;
    expect((await browser.verify(body.data.id)).res.status).toBe(201);

    browser.cookies.set("xt_wallet_proof", token); // even with the original binding cookie
    const replay = await browser.verify(body.data.id);
    expect(replay.res.status).toBe(409);
    expect(replay.body.error.code).toBe("WALLET_PROOF_ALREADY_USED");
  });

  it("refuses completion from another browser (e.g. someone who saw the QR code)", async () => {
    const victim = new Browser();
    const { body } = await victim.challenge();
    xaman.approve(body.data.id, newTestKey());

    const attacker = new Browser();
    const stolen = await attacker.verify(body.data.id);
    expect(stolen.res.status).toBe(403);
    expect(stolen.body.error.code).toBe("WALLET_PROOF_WRONG_BROWSER");
    attacker.cookies.set("xt_wallet_proof", "A".repeat(43));
    expect((await attacker.verify(body.data.id)).res.status).toBe(403);

    // The rightful browser can still finish.
    expect((await victim.verify(body.data.id)).res.status).toBe(201);
  });

  it("refuses an expired request", async () => {
    const browser = new Browser();
    const { body } = await browser.challenge();
    xaman.approve(body.data.id, newTestKey());
    await db.$executeRawUnsafe(
      `UPDATE "WalletProof" SET "createdAt" = now() - interval '20 minutes', "expiresAt" = now() - interval '1 minute'`,
    );
    const res = await browser.verify(body.data.id);
    expect(res.res.status).toBe(410);
    expect(res.body.error.code).toBe("WALLET_PROOF_EXPIRED");
  });

  it("refuses a request that is not signed yet, declined, or signed on another network", async () => {
    const browser = new Browser();
    const { body } = await browser.challenge();
    const pending = await browser.verify(body.data.id);
    expect(pending.res.status).toBe(409);
    expect(pending.body.error.code).toBe("WALLET_PROOF_NOT_SIGNED");

    xaman.approve(body.data.id, newTestKey());
    xaman.entries.get(body.data.id)!.wrongNetwork = true;
    expect((await browser.verify(body.data.id)).res.status).toBe(409);

    // Not consumed by the failures: once properly signed it still works.
    xaman.entries.get(body.data.id)!.wrongNetwork = false;
    expect((await browser.verify(body.data.id)).res.status).toBe(201);
  });

  it("refuses a different wallet than the one requested (mismatched address)", async () => {
    const intended = newTestKey();
    const browser = new Browser();
    const { body } = await browser.challenge({ kind: "SIGN_IN", address: intended.address });
    xaman.approve(body.data.id, newTestKey());
    const res = await browser.verify(body.data.id);
    expect(res.res.status).toBe(403);
    expect(res.body.error.code).toBe("WALLET_MISMATCH");
    expect(await db.walletLink.count()).toBe(0);
  });

  it("refuses a signature made for a different request", async () => {
    const browser = new Browser();
    const { body } = await browser.challenge();
    xaman.approve(body.data.id, newTestKey(), { memoFor: randomUUID() });
    const res = await browser.verify(body.data.id);
    expect(res.res.status).toBe(401);
    expect(res.body.error.code).toBe("WALLET_PROOF_INVALID");
  });

  it("lets only one of two concurrent verifications win", async () => {
    const browser = new Browser();
    const { body } = await browser.challenge();
    xaman.approve(body.data.id, newTestKey());
    const results = await Promise.all([browser.verify(body.data.id), browser.verify(body.data.id)]);
    expect(results.map((r) => r.res.status).sort()).toEqual([201, 409]);
    expect(await db.user.count()).toBe(1);
  });
});

describe("POST /api/auth/verify — signed in", () => {
  async function onboardedBrowser(role: "CUSTOMER" | "SELLER" = "CUSTOMER") {
    const browser = new Browser();
    browser.absorb(
      await onboardingPOST(browser.req("/api/onboarding", { method: "POST", body: { displayName: "Aoife", role } }), ctx),
    );
    return browser;
  }

  it("links the wallet to the current account and marks this session as proven", async () => {
    const browser = await onboardedBrowser();
    const sessionBefore = browser.sessionToken();
    const key = newTestKey();
    const { res, body } = await signInWith(browser, key);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ newAccount: false, needsOnboarding: false });
    expect(browser.sessionToken()).toBe(sessionBefore); // same session, now proven
    const session = await findSessionByToken(db, sessionBefore!);
    expect(session?.walletAddress).toBe(key.address);
    expect((await db.walletLink.findFirstOrThrow()).userId).toBe(session!.userId);
  });

  it("refuses a wallet that belongs to another account", async () => {
    const key = newTestKey();
    await signInWith(new Browser(), key); // the wallet's own account
    const someoneElse = await onboardedBrowser();
    const { res, body } = await signInWith(someoneElse, key);
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("WALLET_LINKED_TO_OTHER_ACCOUNT");
    const session = await findSessionByToken(db, someoneElse.sessionToken()!);
    expect(session?.walletAddress).toBeNull();
  });

  it("lets a real account's other sessions see its verified, still-linked wallet", async () => {
    const key = newTestKey();
    const browser = new Browser();
    const { body } = await signInWith(browser, key);
    const { token } = await createSession(db, body.data.user.id, "ONBOARDING");
    expect((await findSessionByToken(db, token))?.walletAddress).toBe(key.address);
  });

  it("keeps a demo persona's proof to the session that made it", async () => {
    const persona = await db.user.create({
      data: { displayName: "Demo Venue", role: "SELLER", isDemo: true, onboardedAt: new Date() },
    });
    const first = new Browser();
    first.absorb(await demoSessionPOST(first.req("/api/auth/demo-session", { method: "POST", body: { userId: persona.id } }), ctx));
    await signInWith(first, newTestKey());
    expect((await findSessionByToken(db, first.sessionToken()!))?.walletAddress).not.toBeNull();

    const second = new Browser();
    second.absorb(await demoSessionPOST(second.req("/api/auth/demo-session", { method: "POST", body: { userId: persona.id } }), ctx));
    expect((await findSessionByToken(db, second.sessionToken()!))?.walletAddress).toBeNull();
  });

  it("logout with forgetWallet unlinks the wallet from the account", async () => {
    const key = newTestKey();
    const browser = new Browser();
    const first = await signInWith(browser, key);
    const res = await logoutPOST(browser.req("/api/auth/logout", { method: "POST", body: { forgetWallet: true } }), ctx);
    expect(res.status).toBe(200);
    expect((await db.walletLink.findFirstOrThrow()).revokedAt).not.toBeNull();

    // Signing in with that wallet later starts a fresh account instead of the forgotten one.
    const again = await signInWith(new Browser(), key);
    expect(again.body.data.newAccount).toBe(true);
    expect(again.body.data.user.id).not.toBe(first.body.data.user.id);
  });
});

describe("database invariants", () => {
  it("a session cannot claim a wallet without a verification time", async () => {
    const user = await db.user.create({ data: { displayName: "X" } });
    await expect(
      db.session.create({
        data: {
          userId: user.id,
          method: "WALLET",
          tokenHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
          walletAddress: newTestKey().address,
        },
      }),
    ).rejects.toThrow(/Session_wallet_pair/);
  });

  it("stores only a SHA-256 digest of the browser binding token", async () => {
    await expect(
      db.walletProof.create({
        data: {
          signRequestId: randomUUID(),
          browserTokenHash: "raw-token-not-a-hash",
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/WalletProof_browser_token_sha256/);
  });
});
