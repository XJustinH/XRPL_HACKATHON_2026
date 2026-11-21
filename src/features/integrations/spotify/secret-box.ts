import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for Spotify secrets (XRPL-092): AES-256-GCM with a key derived from
 * SESSION_SECRET by HKDF-SHA-256. Server-only.
 *
 * Each purpose (stored tokens, the OAuth cookie) gets its own key through the HKDF `info` label,
 * so a value sealed for one can never be opened as the other. `context` is authenticated but not
 * encrypted (GCM additional data): a token sealed for one user does not open for another, and the
 * OAuth cookie sealed for one session does not open in another.
 */

const VERSION = "v1";
const SALT = "xrpl-ticketing/integrations/spotify";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, SALT, purpose, 32));
  }

  /** `v1.` + base64url(iv | auth tag | ciphertext). A fresh random IV every time. */
  seal(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  /** Throws if the value was tampered with, sealed under another key, or for another context. */
  open(sealed: string, context: string): string {
    const [version, payload, ...rest] = sealed.split(".");
    if (version !== VERSION || !payload || rest.length > 0) throw new Error("Unreadable sealed value");
    const raw = Buffer.from(payload, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Unreadable sealed value");

    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

/** Key labels. Changing one invalidates everything sealed under it. */
export const TOKEN_KEY_PURPOSE = "spotify-tokens-v1";
export const OAUTH_COOKIE_KEY_PURPOSE = "spotify-oauth-cookie-v1";
