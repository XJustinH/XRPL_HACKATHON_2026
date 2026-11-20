// @vitest-environment node
import { describe, expect, it } from "vitest";

import { testTransactionsEnabled } from "../test-transactions";

describe("testTransactionsEnabled", () => {
  it.each([
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "test" }, true],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", XRPL_TEST_TRANSACTIONS_ENABLED: "true" }, true],
    [{ NODE_ENV: "production", XRPL_TEST_TRANSACTIONS_ENABLED: "1" }, true],
    [{ NODE_ENV: "development", XRPL_TEST_TRANSACTIONS_ENABLED: "false" }, false],
    [{ NODE_ENV: "development", XRPL_TEST_TRANSACTIONS_ENABLED: " 0 " }, false],
  ])("%o -> %s", (env, enabled) => {
    expect(testTransactionsEnabled(env)).toBe(enabled);
  });
});
