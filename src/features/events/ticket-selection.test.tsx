import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { TierAvailability } from "@/contracts/inventory";
import { TicketSelection } from "./ticket-selection";
import { tierPurchaseStates } from "./purchase-eligibility";

function tier(overrides: Partial<TierAvailability> = {}): TierAvailability {
  return {
    tierId: "tier-1",
    name: "GA",
    priceDrops: "25000000",
    totalSupply: 100,
    sold: 0,
    remaining: 100,
    pending: 0,
    fromPriceDrops: "25000000",
    ...overrides,
  };
}

function offer(overrides: Partial<PrimaryOfferListing> = {}): PrimaryOfferListing {
  return {
    offerId: "off-1",
    offerIndex: "A".repeat(64),
    nftokenId: "B".repeat(64),
    sellerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    amountDrops: "25000000",
    tierId: "tier-1",
    tierName: "GA",
    ticketId: "tkt-1",
    serial: 7,
    expiresAt: null,
    purchasePending: false,
    ...overrides,
  };
}

const OPEN = { isPublished: true, hasStarted: false };

function renderSelection(
  tiers: TierAvailability[],
  offers: PrimaryOfferListing[],
  context = OPEN,
) {
  return render(
    <TicketSelection eventId="evt-1" tiers={tierPurchaseStates(tiers, offers, context)} />,
  );
}

describe("TicketSelection", () => {
  it("shows ticket type, price and availability", () => {
    renderSelection([tier({ sold: 40, remaining: 60 })], [offer()]);
    expect(screen.getByText("GA")).toBeVisible();
    expect(screen.getByText("25 XRP")).toBeVisible();
    expect(screen.getByText(/60 of 100 available/)).toBeVisible();
  });

  it("enables buying and links to the purchase step when an offer is live", () => {
    renderSelection([tier()], [offer()]);
    const link = screen.getByRole("link", { name: "Buy ticket" });
    expect(link).toHaveAttribute("href", "/events/evt-1/purchase?tier=tier-1");
  });

  it("disables buying when no eligible primary offer exists", () => {
    renderSelection([tier()], []);
    expect(screen.queryByRole("link", { name: "Buy ticket" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy ticket" })).toBeDisabled();
    expect(screen.getByText("Not on sale right now")).toBeVisible();
  });

  it("disables buying and says sold out when nothing remains", () => {
    renderSelection([tier({ sold: 100, remaining: 0 })], [offer()]);
    expect(screen.getByRole("button", { name: "Buy ticket" })).toBeDisabled();
    expect(screen.getByText("Sold out")).toBeVisible();
    expect(screen.getByText(/100 tickets, all sold/)).toBeVisible();
  });

  it("disables buying once the event has started", () => {
    renderSelection([tier()], [offer()], { isPublished: true, hasStarted: true });
    expect(screen.getByRole("button", { name: "Buy ticket" })).toBeDisabled();
    expect(screen.getByText("This event has already started")).toBeVisible();
  });

  it("shows the live offer price rather than the face value when they differ", () => {
    renderSelection([tier({ priceDrops: "25000000" })], [offer({ amountDrops: "30000000" })]);
    expect(screen.getByText("30 XRP")).toBeVisible();
    expect(screen.getByText(/serial #7/)).toBeVisible();
  });

  it("falls back to the face value when nothing is on sale", () => {
    renderSelection([tier({ priceDrops: "25000000" })], []);
    expect(screen.getByText("25 XRP")).toBeVisible();
  });

  it("surfaces purchases in progress", () => {
    renderSelection([tier({ remaining: 5, pending: 2 })], [offer()]);
    expect(screen.getByText(/2 purchase in progress/)).toBeVisible();
  });

  it("disables buying while another buyer holds the only ticket on sale (XRPL-035)", () => {
    renderSelection([tier({ remaining: 1, pending: 1 })], [offer({ purchasePending: true })]);
    expect(screen.queryByRole("link", { name: "Buy ticket" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy ticket" })).toBeDisabled();
    expect(screen.getByText("Being bought right now")).toBeVisible();
  });

  it("still sells a ticket nobody else is buying (XRPL-035)", () => {
    renderSelection(
      [tier({ remaining: 2, pending: 1 })],
      [offer({ offerId: "held", serial: 7, purchasePending: true }), offer({ offerId: "free", serial: 8 })],
    );
    expect(screen.getByRole("link", { name: "Buy ticket" })).toBeVisible();
    expect(screen.getByText(/serial #8/)).toBeVisible();
  });

  it("gates each tier independently", () => {
    renderSelection(
      [
        tier({ tierId: "t1", name: "GA" }),
        tier({ tierId: "t2", name: "VIP", priceDrops: "90000000" }),
      ],
      [offer({ tierId: "t1" })],
    );

    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByRole("link", { name: "Buy ticket" })).toBeVisible();
    expect(within(items[1]!).getByRole("button", { name: "Buy ticket" })).toBeDisabled();
  });

  it("says so plainly when an event has no ticket types", () => {
    renderSelection([], []);
    expect(screen.getByText(/No ticket types have been announced/)).toBeVisible();
  });

  it("escapes a tier id in the purchase link", () => {
    renderSelection([tier({ tierId: "a b&c" })], [offer({ tierId: "a b&c" })]);
    expect(screen.getByRole("link", { name: "Buy ticket" })).toHaveAttribute(
      "href",
      "/events/evt-1/purchase?tier=a%20b%26c",
    );
  });
});
