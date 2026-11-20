// @vitest-environment node
import {
  ConnectionError,
  DisconnectedError,
  NotFoundError,
  RippledError,
  TimeoutError,
  ValidationError,
} from "xrpl";
import { describe, expect, it } from "vitest";

import { toXrplServiceError, XrplServiceError } from "../errors";

const rippled = (token: string) =>
  new RippledError(`rippled said ${token}`, { error: token, status: "error" });

describe("toXrplServiceError", () => {
  it.each([
    [new TimeoutError("slow"), "TIMEOUT", true],
    [new ConnectionError("refused"), "NODE_UNAVAILABLE", true],
    [new DisconnectedError("closed"), "NODE_UNAVAILABLE", true],
    [rippled("actNotFound"), "NOT_FOUND", false],
    [rippled("txnNotFound"), "NOT_FOUND", false],
    [rippled("objectNotFound"), "NOT_FOUND", false],
    [rippled("actMalformed"), "INVALID_INPUT", false],
    [rippled("invalidParams"), "INVALID_INPUT", false],
    [rippled("tooBusy"), "NODE_UNAVAILABLE", true],
    [rippled("noNetwork"), "NODE_UNAVAILABLE", true],
    [rippled("somethingNew"), "RPC_ERROR", false],
    [new ValidationError("bad field"), "INVALID_INPUT", false],
    [new NotFoundError(), "NOT_FOUND", false],
    [new Error("boom"), "UNEXPECTED", false],
    ["a string", "UNEXPECTED", false],
  ] as const)("maps %o to %s", (input, code, retryable) => {
    const error = toXrplServiceError(input, { endpoint: "wss://node", operation: "account_nfts" });
    expect(error).toBeInstanceOf(XrplServiceError);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.endpoint).toBe("wss://node");
    expect(error.message.startsWith("account_nfts: ")).toBe(true);
  });

  it("keeps the rippled error token for callers", () => {
    expect(toXrplServiceError(rippled("actNotFound")).rippledError).toBe("actNotFound");
  });

  it("returns XrplServiceErrors unchanged", () => {
    const original = new XrplServiceError("WRONG_NETWORK", "nope");
    expect(toXrplServiceError(original)).toBe(original);
  });

  it("serialises to a safe API body", () => {
    expect(new XrplServiceError("TIMEOUT", "slow node").toBody()).toEqual({
      code: "TIMEOUT",
      message: "slow node",
      retryable: true,
    });
  });
});
