// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCookieHeader, serializeCookie } from "./cookies";
import {
  hashSessionToken,
  newSessionToken,
  readSessionToken,
  sessionClearCookie,
  sessionCookieName,
  sessionSetCookie,
} from "./session";

afterEach(() => vi.unstubAllEnvs());

describe("cookie helpers", () => {
  it("parses a Cookie header, first occurrence wins, malformed parts skipped", () => {
    const jar = parseCookieHeader('a=1; b="two"; a=3; =bad; noeq; c=%E0%A4%A; d=hello%20world');
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("two");
    expect(jar.has("c")).toBe(false);
    expect(jar.get("d")).toBe("hello world");
  });

  it("serialises attributes and refuses unsafe names", () => {
    expect(
      serializeCookie("x", "v 1", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 }),
    ).toBe("x=v%201; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
    expect(() => serializeCookie("bad name", "v")).toThrow();
  });
});

describe("session tokens", () => {
  it("are 256-bit base64url and stored only as SHA-256 hex", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });
});

describe("session cookie", () => {
  const expires = new Date(Date.now() + 3600_000);

  it("is HttpOnly + SameSite=Lax and not Secure on http", () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    const c = sessionSetCookie("tok", expires);
    expect(c).toMatch(/^xt_session=tok; Path=\//);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).not.toMatch(/Secure/);
  });

  it("is Secure with the __Host- prefix on https", () => {
    vi.stubEnv("APP_BASE_URL", "https://tickets.example");
    expect(sessionCookieName()).toBe("__Host-xt_session");
    const c = sessionSetCookie("tok", expires);
    expect(c).toMatch(/^__Host-xt_session=tok; Path=\//);
    expect(c).toMatch(/; Secure/);
    expect(c).not.toMatch(/Domain=/);
  });

  it("clears with Max-Age=0", () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    expect(sessionClearCookie()).toMatch(/^xt_session=; Path=\/;.*Max-Age=0/);
  });

  it("reads the token from the request", () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    const req = new Request("http://localhost:3000/", { headers: { cookie: "other=1; xt_session=abc" } });
    expect(readSessionToken(req)).toBe("abc");
    expect(readSessionToken(new Request("http://localhost:3000/"))).toBeNull();
  });
});
