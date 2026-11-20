import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TransactionRequest, TransactionRequestStatus } from "@/contracts/xrpl";

import { TestTransactionCheck } from "./test-transaction-check";
import { TransactionApproval } from "./transaction-approval";

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ACCOUNT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const EXPLORER = `https://testnet.xrpl.org/transactions/${TX_HASH}`;

function txRequest(
  status: TransactionRequestStatus,
  extra: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    id: UUID,
    purpose: "TEST",
    reference: null,
    status,
    transactionType: "AccountSet",
    account: ACCOUNT,
    instruction: "Developer check: approve a no-op AccountSet.",
    signUrl: `https://xumm.app/sign/${UUID}`,
    qrPngUrl: `https://xumm.app/sign/${UUID}_q.png`,
    expiresAt: "2026-11-20T19:10:00.000Z",
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

const CONFIRMED = txRequest("CONFIRMED", {
  txHash: TX_HASH,
  engineResult: "tesSUCCESS",
  ledgerIndex: 1234,
  explorerUrl: EXPLORER,
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });

/** Fake API: each status check returns the next answer (the last one repeats). */
function mockApi(answers: TransactionRequest[], cancelled = txRequest("CANCELLED")) {
  const queue = [...answers];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/wallet/transaction-requests" && method === "POST")
      return json(txRequest("PENDING"), 201);
    if (url.startsWith("/api/wallet/transaction-requests/") && method === "DELETE") return json(cancelled);
    if (url.startsWith("/api/wallet/transaction-requests/"))
      return json(queue.length > 1 ? queue.shift() : queue[0]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TransactionApproval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for approval in Xaman with a QR code, a direct link and Cancel", () => {
    mockApi([txRequest("PENDING")]);
    render(<TransactionApproval request={txRequest("PENDING")} pollIntervalMs={5} />);
    expect(screen.getByText("Developer check: approve a no-op AccountSet.")).toBeVisible();
    expect(screen.getByAltText("QR code for the Xaman transaction request")).toHaveAttribute(
      "src",
      `https://xumm.app/sign/${UUID}_q.png`,
    );
    expect(screen.getByRole("link", { name: "Open in Xaman" })).toHaveAttribute(
      "href",
      `https://xumm.app/sign/${UUID}`,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(screen.getByText(/1\. Approve in Xaman/)).toHaveAttribute("aria-current", "step");
  });

  it("moves through submitted to confirmed and links the validated transaction", async () => {
    mockApi([txRequest("OPENED"), txRequest("SUBMITTED", { txHash: TX_HASH }), CONFIRMED]);
    render(<TransactionApproval request={txRequest("PENDING")} pollIntervalMs={5} />);

    // findBy* resolving proves the SUBMITTED state was shown; it may already be gone by the next line.
    await screen.findByText(/Waiting for the XRP Ledger to validate it/);
    expect(await screen.findByText("Confirmed on XRPL Testnet.")).toBeVisible();
    expect(screen.getByRole("link", { name: "View on the XRPL explorer" })).toHaveAttribute("href", EXPLORER);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("explains a ledger rejection, links it and offers a retry", async () => {
    mockApi([
      txRequest("FAILED", {
        txHash: TX_HASH,
        failureReason: "LEDGER_REJECTED",
        engineResult: "tecNO_PERMISSION",
        explorerUrl: EXPLORER,
      }),
    ]);
    const onRetry = vi.fn();
    render(<TransactionApproval request={txRequest("SUBMITTED")} onRetry={onRetry} pollIntervalMs={5} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The XRP Ledger rejected the transaction (tecNO_PERMISSION). The small network fee was charged",
    );
    expect(screen.getByRole("link", { name: "View on the XRPL explorer" })).toHaveAttribute("href", EXPLORER);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    ["REJECTED", {}, "You declined the request in Xaman. Nothing was sent."],
    ["EXPIRED", {}, "The request expired before it was approved. Nothing was sent."],
    [
      "FAILED",
      { failureReason: "NOT_VALIDATED_IN_TIME" },
      "wasn't validated before it expired. Nothing was charged.",
    ],
    [
      "FAILED",
      { failureReason: "NETWORK_REJECTED", engineResult: "tefPAST_SEQ" },
      "refused the transaction (tefPAST_SEQ)",
    ],
    ["FAILED", { failureReason: "WRONG_NETWORK" }, "Switch Xaman to XRPL Testnet and try again."],
  ] as const)("explains %s %o", async (status, extra, message) => {
    mockApi([txRequest(status, extra)]);
    render(<TransactionApproval request={txRequest(status, extra)} onRetry={() => {}} pollIntervalMs={5} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("cancels a request that has not been signed", async () => {
    const fetchMock = mockApi([txRequest("PENDING")]);
    render(<TransactionApproval request={txRequest("PENDING")} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Request cancelled. Nothing was sent.");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/wallet/transaction-requests/${UUID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("TestTransactionCheck", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a test transaction for the connected account and shows its approval", async () => {
    const fetchMock = mockApi([txRequest("PENDING")]);
    render(<TestTransactionCheck address={ACCOUNT} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Send a test transaction" }));

    expect(await screen.findByRole("region", { name: "Approve the test transaction" })).toBeVisible();
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/wallet/transaction-requests",
    )!;
    expect(JSON.parse(String(init?.body))).toEqual({ purpose: "TEST", account: ACCOUNT });
  });
});
