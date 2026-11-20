import type { Request, RequestResponseMap } from "xrpl";

import type { LedgerClient } from "../client";

export interface FakeNode {
  /** Thrown from connect(). */
  connectError?: Error;
  /** network_id reported by server_info. Defaults to 1 (Testnet); set explicitly to undefined to omit it. */
  networkId?: number | undefined;
  /** Handles every request except server_info. */
  handler?: (req: Request) => unknown;
}

/** In-memory stand-in for xrpl.Client. */
export class FakeClient implements LedgerClient {
  connected = false;
  disconnectCalls = 0;
  readonly requests: Request[] = [];

  constructor(
    readonly endpoint: string,
    private readonly node: FakeNode,
  ) {}

  async connect(): Promise<void> {
    if (this.node.connectError) throw this.node.connectError;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCalls += 1;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async request<R extends Request>(req: R): Promise<RequestResponseMap<R>> {
    this.requests.push(req);
    if (req.command === "server_info") {
      const networkId = "networkId" in this.node ? this.node.networkId : 1;
      return {
        result: {
          info: {
            network_id: networkId,
            server_state: "full",
            build_version: "3.4.1",
            validated_ledger: { seq: 100, hash: "LEDGERHASH", age: 2 },
          },
        },
      } as unknown as RequestResponseMap<R>;
    }
    if (!this.node.handler) throw new Error(`FakeClient: no handler for ${req.command}`);
    return (await this.node.handler(req)) as RequestResponseMap<R>;
  }
}

/** Builds a client factory over a map of endpoint -> behaviour and records every client it creates. */
export function fakeNetwork(nodes: Record<string, FakeNode>) {
  const created: FakeClient[] = [];
  const factory = (endpoint: string) => {
    const node = nodes[endpoint];
    if (!node) throw new Error(`FakeClient: unknown endpoint ${endpoint}`);
    const client = new FakeClient(endpoint, node);
    created.push(client);
    return client;
  };
  return { factory, created };
}
