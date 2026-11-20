import { createXrplConnection, loadXrplConfig, type XrplConfig } from "@/lib/xrpl";

/**
 * Live XRPL access for the lifecycle suite (XRPL-050), through the app's connection manager (src/lib/xrpl). It checks
 * that every node reports the configured test network before use, and the config refuses anything but
 * Testnet or Devnet, so this suite can't reach Mainnet.
 *
 * Wallets are throwaway accounts funded by the network's faucet. They exist only in memory for one run:
 * nothing is saved, and seeds are never printed.
 */

export type TestnetConnection = ReturnType<typeof createXrplConnection>;
type LedgerClient = Parameters<Parameters<TestnetConnection["withClient"]>[0]>[0]["client"];
export type TestWallet = Awaited<ReturnType<LedgerClient["fundWallet"]>>["wallet"];

export function openTestnet(): { config: XrplConfig; connection: TestnetConnection } {
  const config = loadXrplConfig();
  return { config, connection: createXrplConnection(config) };
}

/** A new account funded by the faucet. */
export async function fundTestWallet(connection: TestnetConnection, config: XrplConfig): Promise<TestWallet> {
  const { wallet } = await connection.withClient(
    ({ client }) => client.fundWallet(null, { faucetHost: config.faucetHost }),
    "faucet",
  );
  return wallet;
}
