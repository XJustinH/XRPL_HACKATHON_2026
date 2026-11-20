import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TicketOwnership } from "@/contracts/xrpl";

import { OwnershipBadge } from "./ownership-badge";

const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const OWNER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";

function ownership(extra: Partial<TicketOwnership>): TicketOwnership {
  return {
    ticketId: TICKET,
    nftokenId: "00080000A1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF0100000007",
    status: "VERIFIED",
    ownerAddress: OWNER,
    ledgerIndex: 700,
    checkedAt: "2026-11-20T22:30:00.000Z",
    previousOwnerAddress: OWNER,
    changed: false,
    ownedByViewer: false,
    detail: null,
    nftExplorerUrl: null,
    ...extra,
  };
}

function mockApi(answer: Response) {
  const fetchMock = vi.fn(async () => answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });

describe("OwnershipBadge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the viewer holds the ticket only when the ledger verified it", async () => {
    const fetchMock = mockApi(json(ownership({ ownedByViewer: true })));
    render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText("In your wallet")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(`/api/tickets/${TICKET}/ownership`, expect.anything());
  });

  it("shows another verified holder and notes a change of hands", async () => {
    mockApi(json(ownership({ changed: true })));
    render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText(`Held by ${OWNER.slice(0, 6)}…${OWNER.slice(-4)}`)).toBeVisible();
    expect(screen.getByText("Changed hands since the last check")).toBeVisible();
  });

  it("shows unverified ownership as pending, never as owned", async () => {
    mockApi(
      json(
        ownership({
          status: "PENDING",
          ownerAddress: null,
          ownedByViewer: false,
          detail: "The XRP Ledger couldn't be read just now. Try again shortly.",
        }),
      ),
    );
    render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText("Ownership pending")).toBeVisible();
    expect(screen.getByText("The XRP Ledger couldn't be read just now. Try again shortly.")).toBeVisible();
    expect(screen.queryByText("In your wallet")).not.toBeInTheDocument();
  });

  it("treats a failed check as pending too", async () => {
    mockApi(new Response("{}", { status: 503 }));
    render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText("Ownership pending")).toBeVisible();
    expect(screen.getByText("The ledger couldn't be checked just now.")).toBeVisible();
  });

  it("labels unminted and burned tickets", async () => {
    mockApi(json(ownership({ status: "NOT_MINTED", ownerAddress: null })));
    const { unmount } = render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText("Not minted yet")).toBeVisible();
    unmount();
    mockApi(
      json(
        ownership({ status: "BURNED", ownerAddress: null, detail: "This ticket's NFT no longer exists." }),
      ),
    );
    render(<OwnershipBadge ticketId={TICKET} />);
    expect(await screen.findByText("No longer exists")).toBeVisible();
  });
});
