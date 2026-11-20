import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignRequest, SignRequestStatus } from "@/contracts/xrpl";

import { WalletConnectPanel } from "./wallet-connect-panel";
import { resetConnectedWalletCache } from "./wallet-store";

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ADDRESS = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const STORAGE_KEY = "xrpl-ticketing.connected-wallet";

function signRequest(status: SignRequestStatus, extra: Partial<SignRequest> = {}): SignRequest {
  return {
    id: UUID,
    kind: "SIGN_IN",
    status,
    signUrl: `https://xumm.app/sign/${UUID}`,
    qrPngUrl: `https://xumm.app/sign/${UUID}_q.png`,
    expiresAt: "2026-11-20T18:40:00.000Z",
    account: null,
    walletNetwork: null,
    networkMatches: null,
    ...extra,
  };
}

const SIGNED_OK = signRequest("SIGNED", { account: ADDRESS, walletNetwork: "TESTNET", networkMatches: true });
const READY = {
  status: "CONNECTED",
  network: "XRPL Testnet",
  address: ADDRESS,
  balanceDrops: "48600000",
  canPurchase: true,
  blockers: [],
};

const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Fake backend: `poll` answers each status check in turn (the last answer repeats). */
function mockApi({
  create = () => envelope(signRequest("PENDING"), 201),
  poll = [SIGNED_OK],
  cancel = () => envelope(signRequest("CANCELLED")),
}: {
  create?: () => Response;
  poll?: SignRequest[];
  cancel?: () => Response;
}) {
  const answers = [...poll];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/wallet/sign-requests" && method === "POST") return create();
    if (url.startsWith("/api/wallet/sign-requests/") && method === "DELETE") return cancel();
    if (url.startsWith("/api/wallet/sign-requests/")) {
      return envelope(answers.length > 1 ? answers.shift() : answers[0]);
    }
    if (url.startsWith("/api/wallet/readiness")) return envelope(READY);
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WalletConnectPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetConnectedWalletCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers to connect and never asks for a seed", () => {
    mockApi({});
    render(<WalletConnectPanel pollIntervalMs={5} />);
    expect(screen.getByRole("button", { name: "Connect with Xaman" })).toBeEnabled();
    expect(screen.getByText(/never asks for your seed phrase or private key/)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the QR code, then the connected address and spendable balance once approved", async () => {
    mockApi({ poll: [signRequest("PENDING"), signRequest("OPENED"), SIGNED_OK] });
    render(<WalletConnectPanel pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect with Xaman" }));

    expect(await screen.findByAltText("QR code for the Xaman sign-in request")).toHaveAttribute(
      "src",
      `https://xumm.app/sign/${UUID}_q.png`,
    );
    expect(screen.getByRole("link", { name: "Open in Xaman" })).toHaveAttribute(
      "href",
      `https://xumm.app/sign/${UUID}`,
    );

    expect(await screen.findByText(ADDRESS)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Wallet connected" })).toBeVisible();
    expect(await screen.findByText("48.6 XRP")).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      address: ADDRESS,
      network: "TESTNET",
    });
  });

  it("disconnects by forgetting the wallet in this browser", async () => {
    mockApi({});
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ address: ADDRESS, network: "TESTNET", connectedAt: "2026-11-20T18:00:00.000Z" }),
    );
    render(<WalletConnectPanel pollIntervalMs={5} />);
    expect(await screen.findByText(ADDRESS)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("button", { name: "Connect with Xaman" })).toBeVisible();
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("shows the developer transaction check only when the server enables it", async () => {
    mockApi({});
    const wallet = { address: ADDRESS, network: "TESTNET", connectedAt: "2026-11-20T18:00:00.000Z" };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));

    const { unmount } = render(<WalletConnectPanel pollIntervalMs={5} />);
    expect(await screen.findByText(ADDRESS)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send a test transaction" })).not.toBeInTheDocument();
    unmount();

    render(<WalletConnectPanel pollIntervalMs={5} testTransactions />);
    expect(await screen.findByRole("button", { name: "Send a test transaction" })).toBeVisible();
  });

  it("explains how to recover when the wallet signed on the wrong network", async () => {
    mockApi({
      poll: [signRequest("SIGNED", { account: ADDRESS, walletNetwork: "MAINNET", networkMatches: false })],
    });
    render(<WalletConnectPanel pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect with Xaman" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /signed on XRPL Mainnet, but this app uses XRPL Testnet. Switch the network in Xaman's settings/,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("explains a declined request", async () => {
    mockApi({ poll: [signRequest("REJECTED")] });
    render(<WalletConnectPanel pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect with Xaman" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined the request in Xaman");
  });

  it("cancels a pending request", async () => {
    const fetchMock = mockApi({ poll: [signRequest("PENDING")] });
    render(<WalletConnectPanel pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect with Xaman" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Request cancelled.");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/wallet/sign-requests/${UUID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("tells the user when wallet sign-in is unavailable", async () => {
    mockApi({
      create: () =>
        envelope({ error: { code: "SERVICE_UNAVAILABLE", message: "down" }, requestId: "r" }, 503),
    });
    render(<WalletConnectPanel pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect with Xaman" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wallet sign-in isn't available right now");
  });
});
