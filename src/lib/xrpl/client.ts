import { Client } from "xrpl";
import type { Request, RequestResponseMap } from "xrpl";

import type { XrplNetworkStatus } from "@/contracts/xrpl";
import { assertExpectedNetwork, type XrplConfig } from "./config";
import { toXrplServiceError, XrplServiceError } from "./errors";

/** The subset of xrpl.Client the connection manager relies on (lets tests inject fakes). */
export interface LedgerClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  request<R extends Request>(req: R): Promise<RequestResponseMap<R>>;
}

export type ClientFactory<C extends LedgerClient> = (
  endpoint: string,
  options: { timeout: number; connectionTimeout: number },
) => C;

/** A client whose node has been verified to be on the configured network. */
export interface ConnectedLedger<C extends LedgerClient> {
  readonly client: C;
  readonly endpoint: string;
  readonly networkId: number;
}

/** A ledger response plus the endpoint that served it (for provenance). */
export interface LedgerResponse<T> {
  readonly response: T;
  readonly endpoint: string;
}

async function safeDisconnect(client: LedgerClient): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // Already closed or never opened; nothing to clean up.
  }
}

/**
 * Owns one live XRPL WebSocket connection with ordered failover.
 *
 * Every node is checked with `server_info` before first use and refused unless
 * it reports the configured network_id. That makes it impossible to read from
 * or submit to Mainnet through this class, even if an endpoint is misconfigured.
 */
export class XrplConnectionManager<C extends LedgerClient = Client> {
  private current: ConnectedLedger<C> | null = null;
  private connecting: Promise<ConnectedLedger<C>> | null = null;
  private nextIndex = 0;

  constructor(
    private readonly config: XrplConfig,
    private readonly endpoints: readonly string[],
    private readonly createClient: ClientFactory<C>,
  ) {
    if (endpoints.length === 0) {
      throw new XrplServiceError("CONFIG_ERROR", "No XRPL endpoints configured.");
    }
  }

  /** Endpoint currently in use, or null when disconnected. */
  get currentEndpoint(): string | null {
    return this.current?.endpoint ?? null;
  }

  /** Returns a verified connection, connecting (with failover) if needed. Concurrent callers share one attempt. */
  async connect(): Promise<ConnectedLedger<C>> {
    if (this.current?.client.isConnected()) return this.current;
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /**
   * Sends a read-only request. On a timeout or connection failure it fails
   * over to the next endpoint and retries once.
   *
   * Only use this for idempotent reads. Transaction submission must not be
   * retried blindly.
   */
  async request<R extends Request>(
    req: R,
    operation: string = req.command,
  ): Promise<LedgerResponse<RequestResponseMap<R>>> {
    const first = await this.connect();
    try {
      return await this.send(first, req, operation);
    } catch (error) {
      if (!(error instanceof XrplServiceError) || !error.retryable || this.endpoints.length < 2) {
        throw error;
      }
      await this.failover();
      return this.send(await this.connect(), req, operation);
    }
  }

  /**
   * Runs `fn` with the verified client. No automatic retry. Intended for
   * developer tooling such as the faucet script.
   */
  async withClient<T>(
    fn: (ledger: ConnectedLedger<C>) => Promise<T>,
    operation = "xrpl operation",
  ): Promise<T> {
    const ledger = await this.connect();
    try {
      return await fn(ledger);
    } catch (error) {
      throw toXrplServiceError(error, { endpoint: ledger.endpoint, operation });
    }
  }

  /** Current node health, re-checking the network on every call. */
  async getNetworkStatus(): Promise<XrplNetworkStatus> {
    const { response, endpoint } = await this.request({ command: "server_info" });
    const info = response.result.info;
    assertExpectedNetwork(this.config, info.network_id, endpoint);
    const validated = info.validated_ledger;
    // Clio reports clio_version instead of build_version and may omit server_state.
    const clioVersion = (info as { clio_version?: unknown }).clio_version;
    return {
      network: this.config.network,
      networkId: info.network_id,
      endpoint,
      serverState: info.server_state ?? "unknown",
      buildVersion: info.build_version ?? (typeof clioVersion === "string" ? `clio ${clioVersion}` : null),
      validatedLedger: validated
        ? { index: validated.seq, hash: validated.hash, ageSeconds: validated.age }
        : null,
      checkedAt: new Date().toISOString(),
    };
  }

  async disconnect(): Promise<void> {
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
    }
    await this.dropCurrent();
  }

  private async send<R extends Request>(
    ledger: ConnectedLedger<C>,
    req: R,
    operation: string,
  ): Promise<LedgerResponse<RequestResponseMap<R>>> {
    try {
      const response = await ledger.client.request(req);
      return { response, endpoint: ledger.endpoint };
    } catch (error) {
      throw toXrplServiceError(error, { endpoint: ledger.endpoint, operation });
    }
  }

  private async failover(): Promise<void> {
    this.nextIndex = (this.nextIndex + 1) % this.endpoints.length;
    await this.dropCurrent();
  }

  private async dropCurrent(): Promise<void> {
    const previous = this.current;
    this.current = null;
    if (previous) await safeDisconnect(previous.client);
  }

  private async establish(): Promise<ConnectedLedger<C>> {
    await this.dropCurrent();
    const failures: string[] = [];
    let lastFailure: XrplServiceError | undefined;

    for (let attempt = 0; attempt < this.endpoints.length; attempt += 1) {
      const index = (this.nextIndex + attempt) % this.endpoints.length;
      const endpoint = this.endpoints[index] as string;
      try {
        const ledger = await this.open(endpoint);
        this.nextIndex = index;
        this.current = ledger;
        return ledger;
      } catch (error) {
        const failure = toXrplServiceError(error, { endpoint, operation: "connect" });
        // A node on the wrong network is a configuration problem: stop, do not fail over.
        if (failure.code === "WRONG_NETWORK") throw failure;
        failures.push(`${endpoint} (${failure.message})`);
        lastFailure = failure;
      }
    }

    throw new XrplServiceError(
      "NODE_UNAVAILABLE",
      `Could not connect to any XRPL endpoint: ${failures.join("; ")}`,
      { cause: lastFailure },
    );
  }

  private async open(endpoint: string): Promise<ConnectedLedger<C>> {
    const client = this.createClient(endpoint, {
      timeout: this.config.requestTimeoutMs,
      connectionTimeout: this.config.connectTimeoutMs,
    });
    try {
      await client.connect();
      const info = await client.request({ command: "server_info" });
      const networkId = info.result.info.network_id;
      assertExpectedNetwork(this.config, networkId, endpoint);
      return { client, endpoint, networkId };
    } catch (error) {
      await safeDisconnect(client);
      throw error;
    }
  }
}

/** Connection manager over the configured rippled endpoints (or a custom list). */
export function createXrplConnection(
  config: XrplConfig,
  endpoints: readonly string[] = config.wsUrls,
): XrplConnectionManager<Client> {
  return new XrplConnectionManager(config, endpoints, (endpoint, options) => new Client(endpoint, options));
}
