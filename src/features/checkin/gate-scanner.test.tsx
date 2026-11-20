import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FAILURE_COPY, GateScanner } from "./gate-scanner";
import { EntryOverview } from "@/features/organiser/entry-overview";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string) => json(status, { error: { code, message: "x" }, requestId: "r" });

const EVENT = "11111111-1111-4111-8111-111111111111";
const CODE = "xtc1.22222222-2222-4222-8222-222222222222.abc";
const WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const verified = {
  data: { status: "VERIFIED", challengeId: "c", ticketId: "t", eventId: EVENT, nftokenId: "n", ownerAddress: WALLET, ledgerIndex: 99 },
};
const admitted = {
  data: { status: "ADMITTED", ticketId: "t", eventId: EVENT, checkedInAt: "2026-12-01T20:01:00.000Z", ledgerIndex: 99 },
};

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Ticket code"), `${CODE}{Enter}`);
}

describe("GateScanner", () => {
  it("checks a code, then admits on the organiser's tap", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(200, verified)).mockResolvedValueOnce(json(201, admitted));
    render(<GateScanner eventId={EVENT} />);

    await scan(user);
    expect(await screen.findByText("Valid ticket")).toBeInTheDocument();
    expect(screen.getByText("rHb9CJ…tyTh")).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ qrPayload: CODE, eventId: EVENT });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/checkin/verify");

    await user.click(screen.getByRole("button", { name: "Admit" }));
    expect(await screen.findByText("Admitted")).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/checkin/confirm");
    expect(router.refresh).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Scan next ticket" }));
    expect(screen.getByLabelText("Ticket code")).toHaveValue("");
    expect(screen.getByLabelText("Ticket code")).toHaveFocus();
  });

  it("never offers Admit for a rejected ticket", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(fail(409, "ALREADY_USED"));
    render(<GateScanner eventId={EVENT} />);
    await scan(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Already checked in");
    expect(screen.queryByRole("button", { name: "Admit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry when the ledger is unreachable, and admits only after it verifies", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(fail(503, "LEDGER_UNAVAILABLE")).mockResolvedValueOnce(json(200, verified));
    render(<GateScanner eventId={EVENT} />);
    await scan(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Do not admit yet");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Valid ticket")).toBeInTheDocument();
  });

  it("shows a race lost at confirm as already used", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(200, verified)).mockResolvedValueOnce(fail(409, "ALREADY_USED"));
    render(<GateScanner eventId={EVENT} />);
    await scan(user);
    await user.click(await screen.findByRole("button", { name: "Admit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Already checked in");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("handles network failure and unknown codes without admitting", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(fail(500, "INTERNAL"));
    render(<GateScanner eventId={EVENT} />);
    await scan(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  });

  it("does not submit an empty code and hides the camera when unsupported", () => {
    render(<GateScanner eventId={EVENT} />);
    expect(screen.getByRole("button", { name: "Check ticket" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Scan with camera" })).not.toBeInTheDocument();
  });

  it("has guidance for every check-in failure status", async () => {
    const { CHECKIN_FAILURE_STATUSES } = await import("@/contracts/checkin");
    for (const s of CHECKIN_FAILURE_STATUSES) expect(FAILURE_COPY[s], s).toBeDefined();
  });
});

describe("EntryOverview", () => {
  it("shows the count and recent admissions", () => {
    render(
      <EntryOverview
        overview={{
          eventId: EVENT,
          mintedTickets: 120,
          admitted: 1,
          recent: [{ ticketId: "t", serial: 7, tierName: "GA", walletAddress: WALLET, scannedAt: "2026-12-01T20:01:00.000Z" }],
        }}
      />,
    );
    expect(screen.getByText("/ 120 tickets", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("GA #7")).toBeInTheDocument();
    expect(screen.getByText("20:01 UTC")).toBeInTheDocument();
  });

  it("has an empty state", () => {
    render(<EntryOverview overview={{ eventId: EVENT, mintedTickets: 0, admitted: 0, recent: [] }} />);
    expect(screen.getByText("No one has been checked in yet.")).toBeInTheDocument();
  });
});
