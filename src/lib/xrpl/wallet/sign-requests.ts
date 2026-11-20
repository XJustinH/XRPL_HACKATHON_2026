import { isValidClassicAddress } from "xrpl";
import { z } from "zod";

import type { SignRequest, SignRequestStatus } from "@/contracts/xrpl";

import { loadXrplConfig, type XrplConfig } from "../config";
import { XrplServiceError } from "../errors";
import { loadXamanCredentials, XamanClient, type XamanPayloadResult } from "./xaman";

/** How long a sign-in request stays open in Xaman. */
export const SIGN_IN_EXPIRY_MINUTES = 5;
const SIGN_URL_BASE = "https://xumm.app/sign";
const RequestId = z.uuid();

/** Maps Xaman's payload flags onto our sign request lifecycle. */
export function signRequestStatus(meta: XamanPayloadResult["meta"]): SignRequestStatus {
  if (meta.signed) return "SIGNED";
  if (meta.cancelled) return "CANCELLED";
  if (meta.expired) return "EXPIRED";
  if (meta.resolved) return "REJECTED";
  if (meta.app_opened) return "OPENED";
  return "PENDING";
}

function parseRequestId(id: string): string {
  const parsed = RequestId.safeParse(id);
  if (!parsed.success) throw new XrplServiceError("INVALID_INPUT", "Sign request ID must be a UUID");
  return parsed.data;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Wallet sign requests through Xaman (XRPL-011). SIGN_IN asks the user's wallet to
 * sign a sign-in message, which reveals and proves the account without moving funds.
 * It is never submitted to the ledger. Transaction requests follow in XRPL-014.
 */
export class WalletSignRequests {
  constructor(
    private readonly config: XrplConfig,
    private readonly xaman: XamanClient,
  ) {}

  /** Creates a sign-in request pinned to the app's network (Xaman makes the user switch if needed). */
  async createSignIn(): Promise<SignRequest> {
    const created = await this.xaman.createPayload({
      txjson: { TransactionType: "SignIn" },
      options: { expire: SIGN_IN_EXPIRY_MINUTES, force_network: this.config.network },
      custom_meta: {
        instruction: `Connect this account on ${this.config.networkLabel}. Signing in does not move any funds.`,
      },
    });
    return this.get(created.uuid);
  }

  async get(id: string): Promise<SignRequest> {
    const uuid = parseRequestId(id);
    return this.toSignRequest(uuid, await this.load(uuid));
  }

  /** Withdraws a request that has not been answered yet, then returns its current state. */
  async cancel(id: string): Promise<SignRequest> {
    const uuid = parseRequestId(id);
    await this.load(uuid); // only sign-in requests created by this app can be cancelled here
    await this.xaman.cancelPayload(uuid);
    return this.get(uuid);
  }

  /**
   * Server-side detail of a SIGNED sign-in on the right network, including the signed
   * blob. The blob carries Xaman's sign-in memo with this request's ID, which lets
   * XRPL-012 prove wallet control and bind it to a session. Returns null otherwise.
   */
  async getSignedSignIn(id: string): Promise<{ request: SignRequest; signedHex: string | null } | null> {
    const uuid = parseRequestId(id);
    const result = await this.load(uuid);
    const request = this.toSignRequest(uuid, result);
    if (request.status !== "SIGNED" || request.networkMatches !== true) return null;
    return { request, signedHex: result.response.hex ?? null };
  }

  private async load(uuid: string): Promise<XamanPayloadResult> {
    const result = await this.xaman.getPayload(uuid);
    if (result.payload.tx_type !== "SignIn") {
      throw new XrplServiceError("NOT_FOUND", "Sign request not found");
    }
    return result;
  }

  private toSignRequest(uuid: string, result: XamanPayloadResult): SignRequest {
    const status = signRequestStatus(result.meta);
    const signed = status === "SIGNED";
    const account = signed ? (result.response.account ?? null) : null;
    if (signed && (!account || !isValidClassicAddress(account))) {
      throw new XrplServiceError(
        "PROVIDER_UNAVAILABLE",
        "Xaman returned a signed request without a valid account",
      );
    }
    // Xaman reports the network it signed on; when it does not, force_network was enforced.
    const walletNetwork = signed
      ? (result.response.environment_nodetype ?? result.meta.force_network ?? null)
      : null;
    return {
      id: uuid,
      kind: "SIGN_IN",
      status,
      signUrl: `${SIGN_URL_BASE}/${uuid}`,
      qrPngUrl: `${SIGN_URL_BASE}/${uuid}_q.png`,
      expiresAt: isoOrNull(result.payload.expires_at),
      account,
      walletNetwork,
      networkMatches: signed ? walletNetwork === this.config.network : null,
    };
  }
}

export function createWalletSignRequests(
  config: XrplConfig = loadXrplConfig(),
  client: XamanClient = new XamanClient(loadXamanCredentials()),
): WalletSignRequests {
  return new WalletSignRequests(config, client);
}

const SHARED_KEY = Symbol.for("xrpl-ticketing.walletSignRequests");

/** Process-wide shared instance for route handlers. Throws CONFIG_ERROR if Xaman is not configured. */
export function getWalletSignRequests(): WalletSignRequests {
  const store = globalThis as unknown as Record<symbol, WalletSignRequests | undefined>;
  store[SHARED_KEY] ??= createWalletSignRequests();
  return store[SHARED_KEY];
}
