/**
 * Verifies every configured XRPL endpoint is reachable and on the configured test network.
 *
 *   npm run xrpl:check-network
 *
 * Exits non-zero if the config is invalid (including any Mainnet setting) or
 * the primary node fails. Fallback, Clio and RPC problems are warnings.
 */
import {
  assertExpectedNetwork,
  createXrplConnection,
  isXrplServiceError,
  loadXrplConfig,
  type XrplConfig,
} from "@/lib/xrpl";
import { describeError, loadLocalEnv } from "./env";

interface Check {
  role: string;
  target: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

const UNKNOWN_NFT_ID = "0".repeat(64);

async function checkWebSocket(
  config: XrplConfig,
  role: string,
  endpoint: string,
  required: boolean,
): Promise<Check> {
  const connection = createXrplConnection(config, [endpoint]);
  const started = Date.now();
  try {
    const status = await connection.getNetworkStatus();
    const ledger = status.validatedLedger
      ? `validated ledger ${status.validatedLedger.index} (${status.validatedLedger.ageSeconds}s old)`
      : "no validated ledger yet";
    let detail = `network_id ${status.networkId}, ${status.serverState}, ${status.buildVersion ?? "unknown build"}, ${ledger}`;

    if (role === "clio") {
      // nft_info is Clio-only: a well-formed unknown ID returns objectNotFound when supported.
      try {
        await connection.request({ command: "nft_info", nft_id: UNKNOWN_NFT_ID });
        detail += ", nft_info supported";
      } catch (error) {
        if (!(isXrplServiceError(error) && error.code === "NOT_FOUND")) {
          return {
            role,
            target: endpoint,
            ok: false,
            required,
            detail: `nft_info unavailable: ${describeError(error)}`,
          };
        }
        detail += ", nft_info supported";
      }
    }
    return { role, target: endpoint, ok: true, required, detail: `${detail}, ${Date.now() - started} ms` };
  } catch (error) {
    return { role, target: endpoint, ok: false, required, detail: describeError(error) };
  } finally {
    await connection.disconnect();
  }
}

async function checkRpc(config: XrplConfig): Promise<Check> {
  const started = Date.now();
  try {
    const response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "server_info", params: [{}] }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { result?: { info?: { network_id?: number } } };
    const networkId = body.result?.info?.network_id;
    assertExpectedNetwork(config, networkId, config.rpcUrl);
    return {
      role: "rpc",
      target: config.rpcUrl,
      ok: true,
      required: false,
      detail: `network_id ${networkId}, ${Date.now() - started} ms`,
    };
  } catch (error) {
    return { role: "rpc", target: config.rpcUrl, ok: false, required: false, detail: describeError(error) };
  }
}

async function main(): Promise<number> {
  loadLocalEnv();
  let config: XrplConfig;
  try {
    config = loadXrplConfig();
  } catch (error) {
    console.error(`FAIL  configuration: ${describeError(error)}`);
    return 1;
  }

  console.log(
    `XRPL network check: ${config.networkLabel} (every node must report network_id ${config.expectedNetworkId})\n`,
  );

  const [primary, ...fallbacks] = config.wsUrls;
  const checks = await Promise.all([
    checkWebSocket(config, "primary", primary as string, true),
    ...fallbacks.map((url) => checkWebSocket(config, "fallback", url, false)),
    ...(config.clioWsUrl ? [checkWebSocket(config, "clio", config.clioWsUrl, false)] : []),
    checkRpc(config),
  ]);

  for (const check of checks) {
    const mark = check.ok ? "OK  " : check.required ? "FAIL" : "WARN";
    console.log(`${mark}  ${check.role.padEnd(8)} ${check.target}\n      ${check.detail}`);
  }
  console.log(`INFO  explorer ${config.explorerUrl}`);

  const wrongNetwork = checks.some((check) => !check.ok && check.detail.includes("[WRONG_NETWORK]"));
  const requiredFailed = checks.some((check) => check.required && !check.ok);
  if (wrongNetwork || requiredFailed) {
    console.log("\nResult: FAILED. Fix the configuration above before running the app.");
    return 1;
  }
  const warnings = checks.filter((check) => !check.ok).length;
  console.log(
    `\nResult: OK${warnings ? ` with ${warnings} warning(s)` : ""}. The app only uses nodes verified as ${config.networkLabel}, so Mainnet submissions are not possible from this configuration.`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  },
);
