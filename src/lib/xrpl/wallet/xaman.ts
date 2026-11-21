import { z } from "zod";

import { XrplServiceError } from "../errors";

/**
 * Minimal server-side client for the Xaman (formerly Xumm) platform API.
 * Server-only: it uses the API secret. The app never handles a user's seed or
 * private key; users approve requests inside their own Xaman app.
 *
 * API reference: https://docs.xaman.dev/concepts/payloads-sign-requests
 */

const DEFAULT_BASE_URL = "https://xumm.app/api/v1/platform";
const REQUEST_TIMEOUT_MS = 10_000;

export interface XamanCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Reads XAMAN_API_KEY / XAMAN_API_SECRET. Throws CONFIG_ERROR if either is missing. */
export function loadXamanCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): XamanCredentials {
  const apiKey = env.XAMAN_API_KEY?.trim();
  const apiSecret = env.XAMAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new XrplServiceError(
      "CONFIG_ERROR",
      "Wallet signing is not configured: set XAMAN_API_KEY and XAMAN_API_SECRET.",
    );
  }
  return { apiKey, apiSecret };
}

const nullableString = z.string().nullable().optional();

const CreatedPayload = z.object({
  uuid: z.string(),
  next: z.object({ always: z.string() }),
  refs: z.object({ qr_png: z.string(), websocket_status: z.string() }),
  pushed: z.boolean(),
});
export type XamanCreatedPayload = z.infer<typeof CreatedPayload>;

const PayloadResult = z.object({
  meta: z.object({
    exists: z.boolean(),
    uuid: z.string(),
    resolved: z.boolean(),
    signed: z.boolean(),
    cancelled: z.boolean(),
    expired: z.boolean(),
    app_opened: z.boolean(),
    force_network: nullableString,
  }),
  payload: z.object({
    tx_type: z.string(),
    expires_at: nullableString,
    /** The transaction as the app requested it. */
    request_json: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    account: nullableString,
    /** Signed transaction blob (hex), once signed. */
    hex: nullableString,
    txid: nullableString,
    environment_nodetype: nullableString,
    /** Preliminary engine result when Xaman submitted the transaction. */
    dispatched_result: nullableString,
    resolved_at: nullableString,
  }),
  /** Metadata the app attached when creating the request. */
  custom_meta: z
    .object({
      instruction: nullableString,
      blob: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
export type XamanPayloadResult = z.infer<typeof PayloadResult>;

const CancelResult = z.object({
  result: z.object({ cancelled: z.boolean(), reason: z.string() }),
});

export interface CreatePayloadInput {
  txjson: Record<string, unknown>;
  options?: Record<string, unknown>;
  custom_meta?: Record<string, unknown>;
}

const QuotaRefusal = z.object({
  error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }),
});

/** True when an error body says the app's quota is used up. Never throws: an unreadable body is not one. */
async function isQuotaRefusal(response: Response): Promise<boolean> {
  const parsed = QuotaRefusal.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return false;
  const { code, message } = parsed.data.error;
  return Number(code) === 429 || /max payloads|rate ?limit|quota/i.test(message ?? "");
}

export class XamanClient {
  constructor(
    private readonly credentials: XamanCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  createPayload(input: CreatePayloadInput): Promise<XamanCreatedPayload> {
    return this.call("POST", "/payload", CreatedPayload, input);
  }

  getPayload(uuid: string): Promise<XamanPayloadResult> {
    return this.call("GET", `/payload/${encodeURIComponent(uuid)}`, PayloadResult);
  }

  /** Withdraws a request. `cancelled` is false if it was already answered, opened or expired. */
  async cancelPayload(uuid: string): Promise<{ cancelled: boolean; reason: string }> {
    const body = await this.call("DELETE", `/payload/${encodeURIComponent(uuid)}`, CancelResult);
    return body.result;
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.credentials.apiKey,
          "X-API-Secret": this.credentials.apiSecret,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      throw new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman did not respond in time", { cause: error });
    }

    if (response.status === 401 || response.status === 403) {
      throw new XrplServiceError("CONFIG_ERROR", "Xaman rejected the API credentials");
    }
    if (response.status === 404) {
      throw new XrplServiceError("NOT_FOUND", "Sign request not found");
    }
    // Xaman reports a used-up quota as HTTP 400 with its own code 429 in the body
    // ("Max payloads of N exceeded"), so the status alone would read as a malformed request.
    if (response.status === 429 || (response.status === 400 && (await isQuotaRefusal(response)))) {
      throw new XrplServiceError("PROVIDER_LIMIT_REACHED", "Xaman is refusing new requests: the app's request limit is used up");
    }
    if (response.status === 400) {
      throw new XrplServiceError("INVALID_INPUT", "Xaman rejected the sign request");
    }
    if (!response.ok) {
      throw new XrplServiceError("PROVIDER_UNAVAILABLE", `Xaman answered HTTP ${response.status}`);
    }

    const json: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman returned an unexpected response");
    }
    return parsed.data;
  }
}
