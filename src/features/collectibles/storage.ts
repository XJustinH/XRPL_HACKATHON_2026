import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Off-chain media storage (XRPL-071). Collectible media never goes on the ledger: the NFT's
 * metadata links to it, and the bytes live behind this interface under a stable key.
 *
 * The local-disk adapter is what the app ships with. An object store (S3, R2...) is one more
 * class implementing `MediaStorage`, selected in `getMediaStorage()`.
 */
export interface MediaStorage {
  /** Stores `bytes` under `key`, replacing nothing: keys are generated once per upload. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Size in bytes, or null if nothing is stored under `key`. */
  size(key: string): Promise<number | null>;
  /** Bytes `start..end` (inclusive) of the object; the whole object when no range is given. */
  read(key: string, range?: { start: number; end: number }): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/** Keys are server-generated ("<uuid>.<ext>"); anything else is refused, so no path can escape the root. */
const SAFE_KEY = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;

export class LocalDiskMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = path.resolve(directory);
  }

  private pathOf(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`Invalid media storage key: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(this.root, { recursive: true });
    // Write beside the target, then rename: a reader never sees a half-written file.
    const partial = `${target}.partial`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Uint8Array> {
    const handle = await open(this.pathOf(key), "r");
    try {
      const total = (await handle.stat()).size;
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? total - 1, total - 1);
      const length = Math.max(0, end - start + 1);
      const buffer = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, start + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return done === length ? buffer : buffer.subarray(0, done);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

export const DEFAULT_MEDIA_STORAGE_DIR = "./storage/media";

/** The configured storage service: local disk under MEDIA_STORAGE_DIR (default ./storage/media). */
export function getMediaStorage(env: Readonly<Record<string, string | undefined>> = process.env): MediaStorage {
  return new LocalDiskMediaStorage(env.MEDIA_STORAGE_DIR?.trim() || DEFAULT_MEDIA_STORAGE_DIR);
}
