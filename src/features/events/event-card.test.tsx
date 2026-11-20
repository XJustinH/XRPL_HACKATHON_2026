import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventView, TicketTierView } from "@/contracts";
import { EventCard } from "./event-card";

function tier(overrides: Partial<TicketTierView> = {}): TicketTierView {
  return {
    id: "tier-1",
    eventId: "evt-1",
    name: "GA",
    description: "",
    priceDrops: "25000000",
    totalSupply: 100,
    mintedQuantity: 0,
    soldQuantity: 0,
    remaining: 100,
    locked: false,
    ...overrides,
  };
}

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "evt-1",
    seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    title: "Night Market Live",
    description: "",
    startsAt: "2026-12-01T20:00:00.000Z",
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "PUBLISHED",
    artworkUrl: null,
    tiers: [tier()],
    publishedAt: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("EventCard", () => {
  it("shows the date, location and organiser", () => {
    render(<EventCard event={event()} />);
    expect(screen.getByText("Night Market Live")).toBeVisible();
    expect(screen.getByText(/1 Dec 2026/)).toBeVisible();
    expect(screen.getByText("Vicar Street, Dublin")).toBeVisible();
    expect(screen.getByText("by Night Market")).toBeVisible();
  });

  it("links to the matching event details page", () => {
    render(<EventCard event={event({ id: "abc-123" })} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/events/abc-123");
  });

  it("shows the cheapest tier as the starting price", () => {
    render(
      <EventCard
        event={event({
          tiers: [
            tier({ id: "t1", priceDrops: "50000000" }),
            tier({ id: "t2", priceDrops: "15000000" }),
          ],
        })}
      />,
    );
    expect(screen.getByText("From 15 XRP")).toBeVisible();
  });

  it("shows a free tier as the starting price rather than hiding it", () => {
    render(<EventCard event={event({ tiers: [tier({ priceDrops: "0" })] })} />);
    expect(screen.getByText("From 0 XRP")).toBeVisible();
  });

  it("says the price is unannounced when there are no tiers", () => {
    render(<EventCard event={event({ tiers: [] })} />);
    expect(screen.getByText("Price to be announced")).toBeVisible();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it("renders seller artwork when present", () => {
    render(<EventCard event={event({ artworkUrl: "https://example.com/a.png" })} />);
    const image = screen.getByRole("presentation", { hidden: true });
    expect(image).toHaveAttribute("src", "https://example.com/a.png");
    // Decorative: the title already carries the name, so alt is empty.
    expect(image).toHaveAttribute("alt", "");
  });

  it("falls back to an initial when there is no artwork", () => {
    render(<EventCard event={event({ artworkUrl: null })} />);
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("N", { selector: "div" })).toBeVisible();
  });

  it("totals the tickets across tiers", () => {
    render(
      <EventCard
        event={event({
          tiers: [tier({ id: "t1", totalSupply: 100 }), tier({ id: "t2", totalSupply: 20 })],
        })}
      />,
    );
    expect(screen.getByText("120 tickets")).toBeVisible();
  });

  it("uses the singular form for one ticket", () => {
    render(<EventCard event={event({ tiers: [tier({ totalSupply: 1 })] })} />);
    expect(screen.getByText("1 ticket")).toBeVisible();
  });
});
