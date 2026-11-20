// @vitest-environment node
import { describe, expect, it } from "vitest";

import { assertExpectedNetwork, loadXrplConfig } from "../config";
import { XrplServiceError } from "../errors";

function expectConfigError(env: Record<string, string>, message: RegExp) {
  try {
    loadXrplConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(XrplServiceError);
    expect((error as XrplServiceError).code).toBe("CONFIG_ERROR");
    expect((error as XrplServiceError).message).toMatch(message);
    return;
  }
  throw new Error("expected loadXrplConfig to throw");
}

describe("loadXrplConfig", () => {
  it("defaults to XRPL Testnet with a fallback node, Clio and the Testnet explorer", () => {
    const config = loadXrplConfig({});
    expect(config).toMatchObject({
      network: "TESTNET",
      networkLabel: "XRPL Testnet",
      expectedNetworkId: 1,
      clioWsUrl: "wss://clio.altnet.rippletest.net:51233/",
      rpcUrl: "https://s.altnet.rippletest.net:51234/",
      explorerUrl: "https://testnet.xrpl.org",
      faucetHost: "faucet.altnet.rippletest.net",
      requestTimeoutMs: 10_000,
      connectTimeoutMs: 5_000,
    });
    expect(config.wsUrls).toEqual(["wss://s.altnet.rippletest.net:51233/", "wss://testnet.xrpl-labs.com/"]);
  });

  it("supports Devnet (network_id 2) with its own defaults", () => {
    const config = loadXrplConfig({ XRPL_NETWORK: "devnet" });
    expect(config).toMatchObject({
      network: "DEVNET",
      expectedNetworkId: 2,
      explorerUrl: "https://devnet.xrpl.org",
      faucetHost: "faucet.devnet.rippletest.net",
    });
    expect(config.wsUrls).toEqual(["wss://s.devnet.rippletest.net:51233/"]);
  });

  it("treats blank values as unset, like src/lib/env.ts", () => {
    const config = loadXrplConfig({
      XRPL_NETWORK: "",
      XRPL_WS_URL: " ",
      XRPL_WS_FALLBACK_URLS: "",
      XRPL_CLIO_WS_URL: "",
      XRPL_REQUEST_TIMEOUT_MS: "",
    });
    expect(config).toEqual(loadXrplConfig({}));
  });

  it("reads endpoints and timeouts from the environment", () => {
    const config = loadXrplConfig({
      XRPL_NETWORK: "Testnet",
      XRPL_WS_URL: "wss://testnet.xrpl-labs.com",
      XRPL_WS_FALLBACK_URLS: "wss://s.altnet.rippletest.net:51233/, wss://testnet.xrpl-labs.com/",
      XRPL_EXPLORER_URL: "https://testnet.xrpl.org/",
      XRPL_REQUEST_TIMEOUT_MS: "15000",
      XRPL_CONNECT_TIMEOUT_MS: "3000",
    });
    // Duplicates are removed and order is kept (primary first).
    expect(config.wsUrls).toEqual(["wss://testnet.xrpl-labs.com/", "wss://s.altnet.rippletest.net:51233/"]);
    expect(config.explorerUrl).toBe("https://testnet.xrpl.org");
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.connectTimeoutMs).toBe(3_000);
  });

  it('lets "none" disable fallbacks and Clio', () => {
    const config = loadXrplConfig({ XRPL_WS_FALLBACK_URLS: "none", XRPL_CLIO_WS_URL: "NONE" });
    expect(config.wsUrls).toEqual(["wss://s.altnet.rippletest.net:51233/"]);
    expect(config.clioWsUrl).toBeNull();
  });

  it("allows an unencrypted node only on localhost", () => {
    expect(loadXrplConfig({ XRPL_WS_URL: "ws://localhost:6006" }).wsUrls[0]).toBe("ws://localhost:6006/");
    expectConfigError({ XRPL_WS_URL: "ws://testnet.example.com" }, /must use wss:/);
  });

  it.each(["mainnet", "MAINNET", "livenet"])("refuses XRPL_NETWORK=%s", (network) => {
    expectConfigError({ XRPL_NETWORK: network }, /selects XRPL Mainnet, which is disabled/);
  });

  it("refuses unknown networks", () => {
    expectConfigError({ XRPL_NETWORK: "staging" }, /Use "testnet" or "devnet"/);
  });

  it.each([
    ["XRPL_WS_URL", "wss://s1.ripple.com/"],
    ["XRPL_WS_URL", "wss://xrplcluster.com"],
    ["XRPL_WS_FALLBACK_URLS", "wss://xrpl.ws"],
    ["XRPL_CLIO_WS_URL", "wss://s2.ripple.com:443"],
    ["XRPL_RPC_URL", "https://s1.ripple.com:51234/"],
    ["XRPL_EXPLORER_URL", "https://livenet.xrpl.org"],
  ])("refuses known Mainnet host in %s", (variable, url) => {
    expectConfigError({ [variable]: url }, /points at XRPL Mainnet/);
  });

  it("rejects malformed URLs and embedded credentials", () => {
    expectConfigError({ XRPL_WS_URL: "not a url" }, /not a valid URL/);
    expectConfigError({ XRPL_WS_URL: "wss://user:pass@testnet.xrpl-labs.com" }, /credentials/);
  });

  it("rejects out-of-range timeouts", () => {
    expectConfigError({ XRPL_REQUEST_TIMEOUT_MS: "50" }, /XRPL_REQUEST_TIMEOUT_MS/);
    expectConfigError({ XRPL_CONNECT_TIMEOUT_MS: "soon" }, /XRPL_CONNECT_TIMEOUT_MS/);
  });
});

describe("assertExpectedNetwork", () => {
  const config = loadXrplConfig({});

  it("accepts the configured network id", () => {
    expect(() => assertExpectedNetwork(config, 1, "wss://node")).not.toThrow();
  });

  it("refuses Mainnet and names it", () => {
    expect(() => assertExpectedNetwork(config, 0, "wss://node")).toThrow(/XRPL Mainnet/);
  });

  it("refuses Devnet when Testnet is configured", () => {
    expect(() => assertExpectedNetwork(config, 2, "wss://node")).toThrow(/expected 1/);
  });

  it("refuses a node that does not report a network id", () => {
    try {
      assertExpectedNetwork(config, undefined, "wss://node");
    } catch (error) {
      expect((error as XrplServiceError).code).toBe("WRONG_NETWORK");
      return;
    }
    throw new Error("expected assertExpectedNetwork to throw");
  });
});
