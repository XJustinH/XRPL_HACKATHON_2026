import { z } from "zod";

/**
 * Server-only environment. Never import from client components.
 * Local values come from `.env` (see `.env.example`); deployed environments inject their own.
 * Feature owners may extend this schema for their own variables via a reviewed change.
 */

// Treat blank values (`KEY=`) as unset so optional integrations stay optional.
const blankAsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(blankAsUndefined, z.string().optional());
const optionalUrl = z.preprocess(blankAsUndefined, z.url().optional());
const optionalBoolean = z.preprocess(
  (v) => {
    const s = blankAsUndefined(v);
    if (typeof s !== "string") return s;
    const lower = s.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    return s; // rejected below with a clear message
  },
  z.boolean({ error: "Expected true/false/1/0" }).optional(),
);

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// or postgresql:// URL"),
    APP_BASE_URL: z.preprocess(blankAsUndefined, z.url().default("http://localhost:3000")),
    SESSION_SECRET: optionalString,
    // Mainnet is deliberately not accepted during the hackathon.
    XRPL_NETWORK: z.preprocess(blankAsUndefined, z.enum(["testnet", "devnet"]).default("testnet")),
    XRPL_WS_URL: optionalUrl,
    XRPL_RPC_URL: optionalUrl,
    /**
     * Allow signing in as seeded demo personas without a wallet (XRPL-010).
     * Defaults to on outside production and off in production unless set to true.
     */
    DEMO_LOGIN_ENABLED: optionalBoolean,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 characters in production",
      });
    }
    if (env.SESSION_SECRET !== undefined && env.SESSION_SECRET.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 characters",
      });
    }
  })
  .transform((env) => ({
    ...env,
    DEMO_LOGIN_ENABLED: env.DEMO_LOGIN_ENABLED ?? env.NODE_ENV !== "production",
  }));

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Parse once and memoise. Throws with variable names only — never echoes values. */
export function getServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (cached && source === process.env) return cached;
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${problems}`);
  }
  if (source === process.env) cached = result.data;
  return result.data;
}

/** Test helper: forget the memoised env. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
