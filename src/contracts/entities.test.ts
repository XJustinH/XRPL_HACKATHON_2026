import { describe, expect, it } from "vitest";
import * as db from "@/generated/prisma/enums";
import * as dto from "./entities";

// Contracts are client-safe and do not import Prisma, so keep their enums in lock-step here.
const pairs = [
  ["UserRole", dto.UserRole, db.UserRole],
  ["XrplNetwork", dto.XrplNetwork, db.XrplNetwork],
  ["EventStatus", dto.EventStatus, db.EventStatus],
  ["MintStatus", dto.MintStatus, db.MintStatus],
  ["SyncStatus", dto.SyncStatus, db.SyncStatus],
  ["OfferKind", dto.OfferKind, db.OfferKind],
  ["OfferState", dto.OfferState, db.OfferState],
  ["LedgerTxStatus", dto.LedgerTxStatus, db.LedgerTxStatus],
  ["LedgerTxType", dto.LedgerTxType, db.LedgerTxType],
] as const;

describe("contract enums mirror Prisma enums", () => {
  it.each(pairs)("%s", (_name, zodEnum, prismaEnum) => {
    expect([...zodEnum.options].sort()).toEqual(Object.values(prismaEnum).sort());
  });
});

describe("WalletLinkDto", () => {
  it("allows an unverified link but keeps verifiedAt explicit", () => {
    const parsed = dto.WalletLinkDto.parse({
      network: "TESTNET",
      address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      verifiedAt: null,
    });
    expect(parsed.verifiedAt).toBeNull();
    expect(dto.WalletLinkDto.safeParse({ network: "TESTNET", address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }).success).toBe(
      false,
    );
  });

  it("rejects mainnet", () => {
    expect(dto.XrplNetwork.safeParse("MAINNET").success).toBe(false);
  });
});
