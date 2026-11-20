// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getServerEnv } from "./env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("getServerEnv", () => {
  it("applies Testnet defaults", () => {
    const env = getServerEnv({ ...base });
    expect(env.XRPL_NETWORK).toBe("testnet");
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("treats blank optional values as unset", () => {
    const env = getServerEnv({ ...base, XRPL_WS_URL: "", SESSION_SECRET: "" });
    expect(env.XRPL_WS_URL).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
  });

  it("refuses mainnet", () => {
    expect(() => getServerEnv({ ...base, XRPL_NETWORK: "mainnet" })).toThrow(/XRPL_NETWORK/);
  });

  it("requires a strong SESSION_SECRET in production", () => {
    expect(() => getServerEnv({ ...base, NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    expect(() => getServerEnv({ ...base, SESSION_SECRET: "too-short" })).toThrow(/SESSION_SECRET/);
  });

  it("never echoes secret values in errors", () => {
    const secret = "postgresql-but-not-really://super-secret-password";
    expect(() => getServerEnv({ DATABASE_URL: secret })).toThrow(/DATABASE_URL/);
    try {
      getServerEnv({ DATABASE_URL: secret });
    } catch (e) {
      expect(String(e)).not.toContain("super-secret-password");
    }
  });
});

describe("DEMO_LOGIN_ENABLED", () => {
  it("defaults to on outside production and off in production", () => {
    expect(getServerEnv({ ...base }).DEMO_LOGIN_ENABLED).toBe(true);
    expect(
      getServerEnv({ ...base, NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) }).DEMO_LOGIN_ENABLED,
    ).toBe(false);
  });

  it("accepts explicit true/false/1/0 and blank as unset", () => {
    expect(getServerEnv({ ...base, DEMO_LOGIN_ENABLED: "false" }).DEMO_LOGIN_ENABLED).toBe(false);
    expect(getServerEnv({ ...base, DEMO_LOGIN_ENABLED: "0" }).DEMO_LOGIN_ENABLED).toBe(false);
    expect(
      getServerEnv({ ...base, NODE_ENV: "production", SESSION_SECRET: "x".repeat(32), DEMO_LOGIN_ENABLED: "TRUE" })
        .DEMO_LOGIN_ENABLED,
    ).toBe(true);
    expect(getServerEnv({ ...base, DEMO_LOGIN_ENABLED: "" }).DEMO_LOGIN_ENABLED).toBe(true);
  });

  it("rejects anything else", () => {
    expect(() => getServerEnv({ ...base, DEMO_LOGIN_ENABLED: "yes please" })).toThrow(/DEMO_LOGIN_ENABLED/);
  });
});
