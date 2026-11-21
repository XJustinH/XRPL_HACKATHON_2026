import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketHistory } from "@/contracts";
import { CheckLedgerButton } from "./check-ledger-button";
import { TicketHistorySection } from "./ticket-history";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BUYER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const OTHER = "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo";
const HASH = "A".repeat(64);

const history: TicketHistory = {
  ticketId: "3f1a8b0c-0000-4000-8000-000000000001",
  nftokenId: "B".repeat(64),
  ownerVerified: true,
  entries: [
    {
      kind: "PRIMARY_SALE",
      source: "PLATFORM",
      fromAddress: ISSUER,
      toAddress: BUYER,
      amountDrops: "25000000",
      txHash: HASH,
      explorerTxUrl: `https://testnet.xrpl.org/transactions/${HASH}`,
      ledgerIndex: 22485392,
      at: "2026-11-21T00:22:51.000Z",
    },
    {
      kind: "OUTSIDE_APP",
      source: "EXTERNAL",
      fromAddress: BUYER,
      toAddress: OTHER,
      amountDrops: null,
      txHash: null,
      explorerTxUrl: null,
      ledgerIndex: 22486000,
      at: null,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockReset();
});

describe("TicketHistorySection", () => {
  it("tells recorded steps apart from moves outside the app", () => {
    render(<TicketHistorySection history={history} />);
    const [sale, outside] = screen.getAllByRole("listitem");

    expect(sale).toHaveTextContent("Sold by the organiser");
    expect(sale).toHaveTextContent("Recorded");
    expect(sale).toHaveTextContent("25 XRP");
    expect(sale).toHaveTextContent("Ledger 22,485,392");
    expect(screen.getByRole("link", { name: "transaction" })).toHaveAttribute(
      "href",
      `https://testnet.xrpl.org/transactions/${HASH}`,
    );

    expect(outside).toHaveTextContent("Moved outside the app");
    expect(outside).toHaveTextContent("Outside the app");
    expect(outside).toHaveTextContent("The app didn't make this move");
    expect(outside).toHaveTextContent("by ledger 22,486,000");
    expect(outside?.querySelector("a")).toBeNull();
  });

  it("says when later moves can't be shown yet", () => {
    render(<TicketHistorySection history={{ ...history, ownerVerified: false }} />);
    expect(screen.getByText(/any later moves aren't shown yet/)).toBeInTheDocument();
  });
});

describe("CheckLedgerButton", () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reconciles the ticket, reports what changed and refreshes the page", async () => {
    respond(200, {
      data: {
        ownership: { changed: true },
        offers: [{ offerId: "o", kind: "RESALE", ownerAddress: BUYER, previousState: "ACTIVE", state: "STALE" }],
      },
    });
    render(<CheckLedgerButton ticketId="t-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Check the ledger again" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "This ticket has a new holder since it was last checked. 1 listing the ledger no longer backs was closed.",
    );
    expect(fetch).toHaveBeenCalledWith("/api/tickets/t-1/reconcile", expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's error", async () => {
    respond(503, { error: { code: "LEDGER_UNAVAILABLE", message: "The XRPL node is unavailable. Try again shortly." } });
    render(<CheckLedgerButton ticketId="t-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Check the ledger again" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The XRPL node is unavailable"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
