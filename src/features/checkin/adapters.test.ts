// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LedgerUnavailableError } from "./ports";
import { resolveQrSecret } from "./server";
import { XrplLedgerOwnership, unavailableLedger } from "./xrpl-ownership";
import { EventSellerAccess } from "./organiser-access";

const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA2000000D1";
const ADDR = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

describe("XrplLedgerOwnership", () => {
  const provenance = (validated: boolean) => ({ ledgerIndex: 42, validated });

  it("passes through a validated ownership answer", async () => {
    const own = new XrplLedgerOwnership({ verifyOwner: async () => ({ owns: true, provenance: provenance(true) }) });
    expect(await own.checkOwner(NFT, ADDR)).toEqual({ owns: true, ledgerIndex: 42 });
  });

  it("treats a non-validated read as unavailable", async () => {
    const own = new XrplLedgerOwnership({ verifyOwner: async () => ({ owns: true, provenance: provenance(false) }) });
    await expect(own.checkOwner(NFT, ADDR)).rejects.toBeInstanceOf(LedgerUnavailableError);
  });

  it("turns any XRPL error into unavailable (fail closed)", async () => {
    const own = new XrplLedgerOwnership({
      verifyOwner: async () => {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      },
    });
    await expect(own.checkOwner(NFT, ADDR)).rejects.toBeInstanceOf(LedgerUnavailableError);
    await expect(unavailableLedger.checkOwner(NFT, ADDR)).rejects.toBeInstanceOf(LedgerUnavailableError);
  });
});

describe("EventSellerAccess (interim organiser rule)", () => {
  const db = (event: { sellerId: string; seller: { role: string } } | null) =>
    ({ event: { findUnique: async () => event } }) as unknown as ConstructorParameters<typeof EventSellerAccess>[0];

  it("allows only the event's own seller", async () => {
    expect(await new EventSellerAccess(db({ sellerId: "u1", seller: { role: "SELLER" } })).canScanEvent("u1", "e")).toBe(true);
    expect(await new EventSellerAccess(db({ sellerId: "u1", seller: { role: "SELLER" } })).canScanEvent("u2", "e")).toBe(false);
    expect(await new EventSellerAccess(db({ sellerId: "u1", seller: { role: "CUSTOMER" } })).canScanEvent("u1", "e")).toBe(false);
    expect(await new EventSellerAccess(db(null)).canScanEvent("u1", "e")).toBe(false);
  });
});

describe("resolveQrSecret", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  const long = "x".repeat(40);
  it("prefers CHECKIN_QR_SECRET, else derives from SESSION_SECRET", () => {
    expect(resolveQrSecret(env({ CHECKIN_QR_SECRET: long }))).toBe(long);
    const derived = resolveQrSecret(env({ SESSION_SECRET: long }));
    expect(derived).not.toBe(long);
    expect(derived.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses a short secret and missing config in production", () => {
    expect(() => resolveQrSecret(env({ CHECKIN_QR_SECRET: "short" }))).toThrow();
    expect(() => resolveQrSecret(env({ NODE_ENV: "production" }))).toThrow();
  });

  it("uses a stable per-process key in development", () => {
    const dev = env({ NODE_ENV: "development" });
    expect(resolveQrSecret(dev)).toBe(resolveQrSecret(dev));
  });
});
