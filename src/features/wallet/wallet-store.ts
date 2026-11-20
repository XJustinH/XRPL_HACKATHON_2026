import { useSyncExternalStore } from "react";

/**
 * The wallet the user connected in this browser (XRPL-011). Public details only:
 * an address is not a secret and does not prove anything on its own. Linking it to
 * an account with a verified signature is XRPL-012 (Agent A).
 */
export interface ConnectedWallet {
  address: string;
  /** Network the wallet signed in on, e.g. "TESTNET". */
  network: string;
  connectedAt: string;
}

const STORAGE_KEY = "xrpl-ticketing.connected-wallet";
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const listeners = new Set<() => void>();
/** In-memory copy; undefined until first read. Survives when storage is unavailable. */
let current: ConnectedWallet | null | undefined;

function parse(raw: string | null): ConnectedWallet | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ConnectedWallet>;
    if (typeof value.address !== "string" || !CLASSIC_ADDRESS.test(value.address)) return null;
    if (typeof value.network !== "string" || typeof value.connectedAt !== "string") return null;
    return { address: value.address, network: value.network, connectedAt: value.connectedAt };
  } catch {
    return null;
  }
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getConnectedWallet(): ConnectedWallet | null {
  if (current === undefined) current = parse(readStorage());
  return current;
}

export function saveConnectedWallet(wallet: ConnectedWallet): void {
  current = wallet;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
  } catch {
    // Storage blocked (e.g. private mode): stay connected for this page session only.
  }
  notify();
}

/** Disconnect: forget the wallet in this browser. Nothing is stored server-side. */
export function clearConnectedWallet(): void {
  current = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep tabs in sync when another tab connects or disconnects.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    current = parse(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The connected wallet, or null. Always null during server rendering. */
export function useConnectedWallet(): ConnectedWallet | null {
  return useSyncExternalStore(subscribe, getConnectedWallet, () => null);
}

/** Test helper: drop the in-memory copy so the next read comes from storage. */
export function resetConnectedWalletCache(): void {
  current = undefined;
}
