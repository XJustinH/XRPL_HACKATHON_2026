import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionRequest } from "@/contracts/xrpl";

import { AcceptOffer } from "./accept-offer";
import { TicketTransferPanel } from "./ticket-transfer-panel";

// The approval itself is Agent B's component; here it just reports the wallet's answer.
const approvalOutcome = vi.hoisted(() => ({ status: "CONFIRMED" as TransactionRequest["status"] }));
vi.mock("@/features/wallet/transaction-approval", () => ({
  TransactionApproval: (props: { request: TransactionRequest; onFinished?: (r: TransactionRequest) => void }) => (
    <button type="button" onClick={() => props.onFinished?.({ ...props.request, status: approvalOutcome.status })}>
      Finish approval
    </button>
  ),
}));

const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const OFFER = "7be7283c-71b8-47bf-89f0-a0d8183492da";
const HOLDER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";

const request = { id: "req-1", status: "PENDING" } as unknown as TransactionRequest;
const offerDto = (kind: string, state: string, amountDrops: string, destinationAddress: string | null) => ({
  id: OFFER,
  kind,
  state,
  amountDrops,
  destinationAddress,
});

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  approvalOutcome.status = "CONFIRMED";
});

function sentRequest(i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
}

describe("TicketTransferPanel", () => {
  it("lists a ticket for resale at the entered price, then shows the listing", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(json({ offer: offerDto("RESALE", "PENDING_SIGNATURE", "3500000", null), request }, 201))
      .mockReturnValueOnce(json({ offer: offerDto("RESALE", "ACTIVE", "3500000", null) }));
    render(<TicketTransferPanel ticketId={TICKET} holderAddress={HOLDER} openOffer={null} />);

    await user.type(screen.getByLabelText("Price in XRP"), "3.5");
    await user.click(screen.getByRole("button", { name: "List for sale" }));

    const sent = sentRequest();
    expect(sent.url).toBe(`/api/tickets/${TICKET}/resale-offers`);
    expect(sent.body).toEqual({ amountDrops: "3500000" });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{32}$/);

    await user.click(await screen.findByRole("button", { name: "Finish approval" }));
    expect(await screen.findByText(/Listed for resale at 3.5 XRP/)).toBeVisible();
    expect(screen.getByRole("link", { name: "View the listing" })).toHaveAttribute("href", `/offers/${OFFER}`);
  });

  it("asks for confirmation before creating a gift, and Back cancels", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(json({ offer: offerDto("GIFT", "PENDING_SIGNATURE", "0", FRIEND), request }, 201));
    render(<TicketTransferPanel ticketId={TICKET} holderAddress={HOLDER} openOffer={null} />);

    await user.click(screen.getByRole("button", { name: "Gift" }));
    expect(screen.queryByLabelText("Price in XRP")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Friend's XRPL address"), FRIEND);
    await user.click(screen.getByRole("button", { name: "Gift ticket" }));

    expect(screen.getByRole("alertdialog")).toHaveTextContent("can't be undone");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Gift ticket" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Gift ticket" }));
    await user.click(screen.getByRole("button", { name: "Yes, create the gift" }));
    expect(sentRequest().url).toBe(`/api/tickets/${TICKET}/gift-offers`);
    expect(sentRequest().body).toEqual({ destination: FRIEND });
  });

  it("sends a private sale to the friend's address with a price", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(json({ offer: offerDto("PRIVATE", "PENDING_SIGNATURE", "2000000", FRIEND), request }, 201));
    render(<TicketTransferPanel ticketId={TICKET} holderAddress={HOLDER} openOffer={null} />);

    await user.click(screen.getByRole("button", { name: "Sell to a friend" }));
    await user.type(screen.getByLabelText("Friend's XRPL address"), FRIEND);
    await user.type(screen.getByLabelText("Price in XRP"), "2");
    await user.click(screen.getByRole("button", { name: "Create private sale" }));

    expect(sentRequest().url).toBe(`/api/tickets/${TICKET}/private-offers`);
    expect(sentRequest().body).toEqual({ destination: FRIEND, amountDrops: "2000000" });
  });

  it("checks the fields before asking the server", async () => {
    const user = userEvent.setup();
    render(<TicketTransferPanel ticketId={TICKET} holderAddress={HOLDER} openOffer={null} />);

    await user.click(screen.getByRole("button", { name: "List for sale" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Price is required");
    await user.type(screen.getByLabelText("Price in XRP"), "0");
    await user.click(screen.getByRole("button", { name: "List for sale" }));
    expect(screen.getByRole("alert")).toHaveTextContent("choose Gift");

    await user.click(screen.getByRole("button", { name: "Gift" }));
    await user.type(screen.getByLabelText("Friend's XRPL address"), HOLDER);
    await user.click(screen.getByRole("button", { name: "Gift ticket" }));
    expect(screen.getByRole("alert")).toHaveTextContent("your own wallet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the link to send for an offer that is already open", () => {
    render(
      <TicketTransferPanel
        ticketId={TICKET}
        holderAddress={HOLDER}
        openOffer={{ id: OFFER, kind: "GIFT", state: "ACTIVE", amountDrops: "0", destinationAddress: FRIEND }}
      />,
    );
    expect(screen.getByText(/Gift ready for r9cZA1…nfk59/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open the offer link" })).toHaveAttribute("href", `/offers/${OFFER}`);
    expect(screen.queryByRole("button", { name: "List for sale" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when the offer can't be made", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(json({ code: "CONFLICT", message: "This ticket has already been used to enter the event" }, 409));
    render(<TicketTransferPanel ticketId={TICKET} holderAddress={HOLDER} openOffer={null} />);

    await user.type(screen.getByLabelText("Price in XRP"), "3");
    await user.click(screen.getByRole("button", { name: "List for sale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already been used");
  });
});

describe("AcceptOffer", () => {
  it("accepts a gift and confirms the ticket arrived", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(json({ offerId: OFFER, amountDrops: "0", request }, 201))
      .mockReturnValueOnce(json({ offer: offerDto("GIFT", "ACCEPTED", "0", FRIEND), nftExplorerUrl: "https://x/nft", acceptTxExplorerUrl: null }));
    render(<AcceptOffer offerId={OFFER} kind="GIFT" amountDrops="0" />);

    await user.click(screen.getByRole("button", { name: "Accept the gift" }));
    expect(sentRequest().url).toBe(`/api/offers/${OFFER}/accept-intent`);
    await user.click(await screen.findByRole("button", { name: "Finish approval" }));

    expect(await screen.findByText("The ticket is now in your wallet.")).toBeVisible();
    expect(screen.getByRole("link", { name: "See my tickets" })).toHaveAttribute("href", "/tickets");
  });

  it("says when the offer is no longer open", async () => {
    const user = userEvent.setup();
    approvalOutcome.status = "FAILED";
    fetchMock
      .mockReturnValueOnce(json({ offerId: OFFER, amountDrops: "3000000", request }, 201))
      .mockReturnValueOnce(json({ offer: offerDto("RESALE", "STALE", "3000000", null), nftExplorerUrl: "", acceptTxExplorerUrl: null }));
    render(<AcceptOffer offerId={OFFER} kind="RESALE" amountDrops="3000000" />);

    await user.click(screen.getByRole("button", { name: "Buy for 3 XRP" }));
    await user.click(await screen.findByRole("button", { name: "Finish approval" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("no longer open"));
  });
});
