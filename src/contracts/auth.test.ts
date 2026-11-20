import { describe, expect, it } from "vitest";
import * as db from "@/generated/prisma/enums";
import { DisplayName, OnboardingRequest, SelfServeRole, SessionMethod, UpdateMeRequest } from "./auth";

describe("auth contract", () => {
  it("SessionMethod mirrors the Prisma enum", () => {
    expect([...SessionMethod.options].sort()).toEqual(Object.values(db.SessionMethod).sort());
  });

  it("only CUSTOMER and SELLER are self-service roles", () => {
    expect(SelfServeRole.options).toEqual(["CUSTOMER", "SELLER"]);
    expect(SelfServeRole.safeParse("ORGANISER").success).toBe(false);
  });

  it("DisplayName trims and bounds its input", () => {
    expect(DisplayName.parse("  Aoife  ")).toBe("Aoife");
    expect(DisplayName.safeParse(" a ").success).toBe(false);
    expect(DisplayName.safeParse("x".repeat(81)).success).toBe(false);
    expect(DisplayName.safeParse("Tab\there").success).toBe(false);
    expect(DisplayName.safeParse("Siobhán Ní Bhriain").success).toBe(true);
  });

  it("OnboardingRequest rejects unknown fields", () => {
    expect(OnboardingRequest.safeParse({ displayName: "Aoife", role: "CUSTOMER" }).success).toBe(true);
    expect(OnboardingRequest.safeParse({ displayName: "Aoife", role: "CUSTOMER", isDemo: true }).success).toBe(false);
  });

  it("UpdateMeRequest needs at least one known field and never accepts role", () => {
    expect(UpdateMeRequest.safeParse({ displayName: "Aoife" }).success).toBe(true);
    expect(UpdateMeRequest.safeParse({}).success).toBe(false);
    expect(UpdateMeRequest.safeParse({ role: "SELLER" }).success).toBe(false);
  });
});
