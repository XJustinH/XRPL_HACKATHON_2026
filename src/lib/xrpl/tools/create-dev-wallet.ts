/**
 * Creates and funds a throwaway XRPL Testnet (or Devnet) wallet from the public faucet.
 * Developer tooling only: it is not an app feature, and these wallets must
 * never be used on Mainnet or hold anything of value.
 *
 *   npm run xrpl:dev-wallet -- <label>     create and fund a wallet, e.g. "seller"
 *   npm run xrpl:dev-wallet -- --list      list saved wallets (no seeds shown)
 *
 * Seeds are written only to .xrpl-dev-wallets.local.json, which must be
 * git-ignored (the script checks and refuses otherwise). Seeds are never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { createXrplConnection, explorerAccountUrl, loadXrplConfig } from "@/lib/xrpl";
import { describeError, loadLocalEnv } from "./env";

const WALLET_FILE = ".xrpl-dev-wallets.local.json";
const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

interface DevWalletRecord {
  label: string;
  address: string;
  publicKey: string;
  seed: string;
  network: string;
  fundedXrp: number;
  createdAt: string;
}

function assertGitIgnored(file: string): void {
  const result = spawnSync("git", ["check-ignore", "--quiet", file]);
  if (result.error) {
    throw new Error(
      `Could not run git to confirm ${file} is ignored (${result.error.message}). Refusing to write seeds.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${file} is not git-ignored. Refusing to write wallet seeds to it.`);
  }
}

function readWallets(): DevWalletRecord[] {
  if (!existsSync(WALLET_FILE)) return [];
  const parsed: unknown = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${WALLET_FILE} is not a JSON array; fix or delete it.`);
  return parsed as DevWalletRecord[];
}

function listWallets(explorerUrl: string): void {
  const wallets = readWallets();
  if (wallets.length === 0) {
    console.log(`No dev wallets yet. Create one with: npm run xrpl:dev-wallet -- <label>`);
    return;
  }
  for (const wallet of wallets) {
    console.log(
      `${wallet.label.padEnd(16)} ${wallet.address}  ${explorerAccountUrl({ explorerUrl }, wallet.address)}`,
    );
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadXrplConfig();
  const argument = process.argv[2]?.trim() ?? "";

  if (argument === "--list") {
    listWallets(config.explorerUrl);
    return;
  }
  const label = argument || "dev";
  if (!LABEL_PATTERN.test(label)) {
    throw new Error('Label must be 1-32 letters, digits, "-" or "_".');
  }

  assertGitIgnored(WALLET_FILE);
  const wallets = readWallets();
  if (wallets.some((wallet) => wallet.label === label)) {
    throw new Error(`A dev wallet labelled "${label}" already exists. Pick another label.`);
  }

  const connection = createXrplConnection(config);
  try {
    // The connection is verified as the configured test network before the faucet is called.
    const { wallet, balance } = await connection.withClient(
      ({ client }) => client.fundWallet(null, { faucetHost: config.faucetHost }),
      "faucet",
    );
    if (!wallet.seed) throw new Error("Faucet wallet has no seed; nothing was saved.");

    const record: DevWalletRecord = {
      label,
      address: wallet.classicAddress,
      publicKey: wallet.publicKey,
      seed: wallet.seed,
      network: config.network,
      fundedXrp: balance,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(WALLET_FILE, `${JSON.stringify([...wallets, record], null, 2)}\n`, { mode: 0o600 });

    console.log(`Created and funded ${config.networkLabel} wallet "${label}"`);
    console.log(`  address:  ${record.address}`);
    console.log(`  balance:  ${balance} XRP (${config.networkLabel}, no real value)`);
    console.log(`  explorer: ${explorerAccountUrl(config, record.address)}`);
    console.log(`  seed:     saved to ${WALLET_FILE} (git-ignored). Never share it or use it on Mainnet.`);
  } finally {
    await connection.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
