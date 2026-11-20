import type { XrplNetwork } from "@/contracts/entities";

import { XrplServiceError } from "./errors";

interface NetworkDefinition {
  network: XrplNetwork;
  label: string;
  networkId: number;
  faucetHost: string;
  defaults: {
    wsUrls: readonly [string, ...string[]];
    clioWsUrl: string;
    rpcUrl: string;
    explorerUrl: string;
  };
}

/**
 * Networks the app may use, keyed by the `XRPL_NETWORK` value. Testnet is the
 * hackathon default; Devnet is allowed by ADR 0001. Mainnet is deliberately
 * absent: adding it needs a separate, explicit project decision.
 */
export const SUPPORTED_NETWORKS = {
  testnet: {
    network: "TESTNET",
    label: "XRPL Testnet",
    networkId: 1,
    faucetHost: "faucet.altnet.rippletest.net",
    defaults: {
      wsUrls: ["wss://s.altnet.rippletest.net:51233/", "wss://testnet.xrpl-labs.com/"],
      clioWsUrl: "wss://clio.altnet.rippletest.net:51233/",
      rpcUrl: "https://s.altnet.rippletest.net:51234/",
      explorerUrl: "https://testnet.xrpl.org",
    },
  },
  devnet: {
    network: "DEVNET",
    label: "XRPL Devnet",
    networkId: 2,
    faucetHost: "faucet.devnet.rippletest.net",
    defaults: {
      wsUrls: ["wss://s.devnet.rippletest.net:51233/"],
      clioWsUrl: "wss://clio.devnet.rippletest.net:51233/",
      rpcUrl: "https://s.devnet.rippletest.net:51234/",
      explorerUrl: "https://devnet.xrpl.org",
    },
  },
} as const satisfies Record<string, NetworkDefinition>;

export type XrplNetworkSetting = keyof typeof SUPPORTED_NETWORKS;

/** XRPL Mainnet's network ID. Any node reporting it is refused. */
export const MAINNET_NETWORK_ID = 0;

/**
 * Hosts known to serve XRPL Mainnet. Rejecting them at config time is defence in
 * depth; the authoritative check is the network_id every node must report on connect.
 */
export const KNOWN_MAINNET_HOSTS: ReadonlySet<string> = new Set([
  "s1.ripple.com",
  "s2.ripple.com",
  "xrplcluster.com",
  "xrpl.ws",
  "xrpl.link",
  "livenet.xrpl.org",
]);

/** Value that switches off an optional endpoint (fallbacks, Clio). Blank means "use the default". */
export const DISABLED = "none";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface XrplConfig {
  readonly network: XrplNetwork;
  readonly networkLabel: string;
  /** network_id every node must report before it is used. */
  readonly expectedNetworkId: number;
  /** WebSocket endpoints in failover order (primary first). */
  readonly wsUrls: readonly string[];
  /** Clio WebSocket endpoint for Clio-only methods such as nft_info; null when disabled. */
  readonly clioWsUrl: string | null;
  /** HTTP JSON-RPC endpoint, used by tooling and health checks. */
  readonly rpcUrl: string;
  /** Block explorer base URL (no trailing slash). */
  readonly explorerUrl: string;
  /** Faucet used by developer tooling only. Never an app feature. */
  readonly faucetHost: string;
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function configError(message: string): XrplServiceError {
  return new XrplServiceError("CONFIG_ERROR", message);
}

/** Blank values count as unset, matching src/lib/env.ts. */
function setting(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseNetwork(raw: string | undefined): XrplNetworkSetting {
  const value = setting(raw)?.toLowerCase() ?? "testnet";
  if (value === "testnet" || value === "devnet") return value;
  if (value === "mainnet" || value === "livenet") {
    throw configError(
      `XRPL_NETWORK="${raw}" selects XRPL Mainnet, which is disabled. This project uses Testnet; enabling Mainnet needs an explicit project decision.`,
    );
  }
  throw configError(`XRPL_NETWORK="${raw}" is not supported. Use "testnet" or "devnet".`);
}

interface UrlRule {
  secure: readonly string[];
  /** Unencrypted protocols, allowed only for a local node. */
  localOnly: readonly string[];
}

const WS_RULE: UrlRule = { secure: ["wss:"], localOnly: ["ws:"] };
const HTTP_RULE: UrlRule = { secure: ["https:"], localOnly: ["http:"] };
const EXPLORER_RULE: UrlRule = { secure: ["https:"], localOnly: [] };

function checkUrl(raw: string, variable: string, rule: UrlRule): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError(`${variable} is not a valid URL: "${raw}"`);
  }
  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host);
  if (!rule.secure.includes(url.protocol) && !(isLocal && rule.localOnly.includes(url.protocol))) {
    const local = rule.localOnly.length
      ? ` (unencrypted ${rule.localOnly.join("/")} only for localhost)`
      : "";
    throw configError(`${variable} must use ${rule.secure.join("/")}${local}.`);
  }
  if (url.username || url.password) {
    throw configError(`${variable} must not contain credentials.`);
  }
  if (KNOWN_MAINNET_HOSTS.has(host)) {
    throw configError(`${variable} points at XRPL Mainnet (${host}). This project does not use Mainnet.`);
  }
  return url.toString();
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseTimeout(raw: string | undefined, variable: string, fallback: number): number {
  const value = setting(raw);
  if (value === undefined) return fallback;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1000 || ms > 120_000) {
    throw configError(`${variable} must be an integer number of milliseconds between 1000 and 120000.`);
  }
  return ms;
}

/**
 * Reads and validates XRPL settings from environment variables. Throws an
 * XrplServiceError with code CONFIG_ERROR on any invalid or Mainnet value.
 *
 * Unset or blank variables use the network's defaults. `XRPL_WS_FALLBACK_URLS=none`
 * disables fallback nodes and `XRPL_CLIO_WS_URL=none` disables Clio.
 */
export function loadXrplConfig(env: Env = process.env): XrplConfig {
  const key = parseNetwork(env.XRPL_NETWORK);
  const definition = SUPPORTED_NETWORKS[key];
  const { defaults } = definition;

  const primary = setting(env.XRPL_WS_URL) ?? defaults.wsUrls[0];
  const fallbackSetting = setting(env.XRPL_WS_FALLBACK_URLS);
  const fallbacks =
    fallbackSetting === undefined
      ? defaults.wsUrls.slice(1)
      : fallbackSetting.toLowerCase() === DISABLED
        ? []
        : splitList(fallbackSetting);
  const wsUrls = [
    ...new Set([
      checkUrl(primary, "XRPL_WS_URL", WS_RULE),
      ...fallbacks.map((url) => checkUrl(url, "XRPL_WS_FALLBACK_URLS", WS_RULE)),
    ]),
  ];

  const clioSetting = setting(env.XRPL_CLIO_WS_URL) ?? defaults.clioWsUrl;
  const clioWsUrl =
    clioSetting.toLowerCase() === DISABLED ? null : checkUrl(clioSetting, "XRPL_CLIO_WS_URL", WS_RULE);

  const rpcUrl = checkUrl(setting(env.XRPL_RPC_URL) ?? defaults.rpcUrl, "XRPL_RPC_URL", HTTP_RULE);
  const explorerUrl = checkUrl(
    setting(env.XRPL_EXPLORER_URL) ?? defaults.explorerUrl,
    "XRPL_EXPLORER_URL",
    EXPLORER_RULE,
  ).replace(/\/+$/, "");

  return Object.freeze({
    network: definition.network,
    networkLabel: definition.label,
    expectedNetworkId: definition.networkId,
    wsUrls: Object.freeze(wsUrls),
    clioWsUrl,
    rpcUrl,
    explorerUrl,
    faucetHost: definition.faucetHost,
    requestTimeoutMs: parseTimeout(env.XRPL_REQUEST_TIMEOUT_MS, "XRPL_REQUEST_TIMEOUT_MS", 10_000),
    connectTimeoutMs: parseTimeout(env.XRPL_CONNECT_TIMEOUT_MS, "XRPL_CONNECT_TIMEOUT_MS", 5_000),
  });
}

/**
 * Refuses any node whose reported network_id differs from the configured network.
 * A node that does not report a network_id is refused too (fail closed).
 */
export function assertExpectedNetwork(
  config: Pick<XrplConfig, "expectedNetworkId" | "networkLabel">,
  reportedNetworkId: number | undefined | null,
  endpoint: string,
): asserts reportedNetworkId is number {
  if (reportedNetworkId === undefined || reportedNetworkId === null) {
    throw new XrplServiceError(
      "WRONG_NETWORK",
      `${endpoint} did not report a network_id, so it cannot be confirmed as ${config.networkLabel}. Refusing to use it.`,
      { endpoint },
    );
  }
  if (reportedNetworkId !== config.expectedNetworkId) {
    const mainnet = reportedNetworkId === MAINNET_NETWORK_ID ? " (XRPL Mainnet)" : "";
    throw new XrplServiceError(
      "WRONG_NETWORK",
      `${endpoint} reported network_id ${reportedNetworkId}${mainnet}; expected ${config.expectedNetworkId} (${config.networkLabel}). Refusing to use it.`,
      { endpoint },
    );
  }
}
