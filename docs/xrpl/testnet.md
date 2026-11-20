# XRPL Testnet setup (Agent B, XRPL-006)

Everything in this project talks to an XRPL **test network**: Testnet by default, Devnet if
chosen (ADR 0001). This page covers how the network is configured, how Mainnet is blocked, and how
to get throwaway test wallets. Code lives in `src/lib/xrpl/`; types live in `src/contracts/xrpl.ts`.

## Configuration

Set these in `.env` (copied from `.env.example`). Blank or unset values use the selected network's
defaults, the same "blank means unset" rule as `src/lib/env.ts`.

| Variable | Testnet default | Purpose |
|---|---|---|
| `XRPL_NETWORK` | `testnet` | `testnet` or `devnet`. `mainnet`/`livenet` fail at startup. |
| `XRPL_WS_URL` | `wss://s.altnet.rippletest.net:51233/` | Primary WebSocket node. |
| `XRPL_WS_FALLBACK_URLS` | `wss://testnet.xrpl-labs.com/` | Comma-separated fallback nodes, tried in order. `none` = no fallback. |
| `XRPL_CLIO_WS_URL` | `wss://clio.altnet.rippletest.net:51233/` | Clio node for Clio-only lookups (`nft_info`). `none` = disabled. |
| `XRPL_RPC_URL` | `https://s.altnet.rippletest.net:51234/` | HTTP JSON-RPC, used by tooling and health checks. |
| `XRPL_EXPLORER_URL` | `https://testnet.xrpl.org` | Explorer for transaction/account/NFT links. |
| `XRPL_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout (1000-120000). |
| `XRPL_CONNECT_TIMEOUT_MS` | `5000` | Per-node connection timeout (1000-120000). |

Devnet defaults: `wss://s.devnet.rippletest.net:51233/`, Clio `wss://clio.devnet.rippletest.net:51233/`,
explorer `https://devnet.xrpl.org`, `network_id` 2. When switching networks, blank any URL you set by
hand. A Testnet URL with `XRPL_NETWORK=devnet` is refused, because the node reports the wrong network.

Remote nodes must use `wss://`/`https://`. Plain `ws://`/`http://` is accepted only for `localhost`, so
a local rippled in standalone mode still works.

## How Mainnet is blocked

1. **Config:** `loadXrplConfig()` accepts only `testnet` or `devnet` for `XRPL_NETWORK`.
2. **Known hosts:** URLs pointing at well-known Mainnet hosts (`s1.ripple.com`, `s2.ripple.com`,
   `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, `livenet.xrpl.org`) are rejected.
3. **Runtime (authoritative):** before any node is used, `XrplConnectionManager` calls `server_info`
   and refuses the node unless it reports the configured `network_id` (Testnet 1, Devnet 2). A node that
   reports Mainnet (`0`) or no network id at all raises `WRONG_NETWORK` and is never used. There is no
   failover around this, because it means the configuration is wrong.

All ledger access in this codebase goes through `XrplConnectionManager`, so nothing can reach Mainnet
from the demo configuration. User transactions are signed in the user's own wallet (XRPL-011/014),
which will also be pinned to the test network.

## Commands

```bash
npm run xrpl:check-network          # live check of every configured endpoint
npm run xrpl:dev-wallet -- seller   # create + fund a throwaway wallet labelled "seller"
npm run xrpl:dev-wallet -- --list   # list saved dev wallets (addresses only)
```

`xrpl:check-network` exits non-zero if the config is invalid, a node is on the wrong network, or the
primary node is down. Fallback, Clio and RPC problems are reported as warnings.

The scripts live in `src/lib/xrpl/tools/` (Agent B's folder) rather than `scripts/` (Agent E's).
They read `.env.local` and then `.env`, and variables already set in the shell take precedence.

### Dev wallets

- Funded from the public faucet of the configured test network. They are **developer tooling, not an app feature**.
- Seeds are written only to `.xrpl-dev-wallets.local.json`. The script checks with `git check-ignore`
  that the file is ignored and refuses to write otherwise. Seeds are never printed to the terminal.
- Each teammate creates their own. Do not share seeds in chat, issues or commits.
- The Testnet is reset from time to time, which deletes all accounts. If a wallet stops existing,
  create a new one.
- App users never give the app a seed. Real flows use wallet sign requests (XRPL-011/014).

## Using the module

```ts
import { createXrplConnection, loadXrplConfig } from "@/lib/xrpl";

const config = loadXrplConfig(); // throws CONFIG_ERROR on bad or Mainnet settings
const xrpl = createXrplConnection(config); // lazy; connects and verifies on first use

const status = await xrpl.getNetworkStatus(); // XrplNetworkStatus (src/contracts/xrpl.ts)
const { response, endpoint } = await xrpl.request({ command: "account_info", account });
```

`request()` is for **idempotent reads**. On a timeout or dropped connection it fails over to the next
node and retries once. Do not use it to submit transactions.

Every failure is an `XrplServiceError` with a stable `code`:

| Code | Meaning | Retry? |
|---|---|---|
| `CONFIG_ERROR` | Invalid or Mainnet configuration | No |
| `INVALID_INPUT` | Malformed address/ID or request | No |
| `NOT_FOUND` | Account/tx/object not on the validated ledger | No |
| `TIMEOUT` | Node did not answer in time | Yes |
| `NODE_UNAVAILABLE` | No node reachable, or node busy/not synced | Yes |
| `WRONG_NETWORK` | Node is not on the configured network | No (fix config) |
| `RPC_ERROR` | Other ledger error | No |
| `UNEXPECTED` | Unclassified failure | No |

API routes map these onto the shared envelope (`LEDGER_UNAVAILABLE` etc. in `src/contracts/common.ts`).
That mapping arrives with the first XRPL routes (XRPL-007).
