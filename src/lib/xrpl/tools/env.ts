import { existsSync } from "node:fs";

/**
 * Loads .env.local then .env, if present. Variables already set in the shell
 * win, and .env.local wins over .env.
 */
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `[${code}] ${error.message}` : error.message;
  }
  return String(error);
}
