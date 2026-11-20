import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { TicketView } from "@/contracts";
import { ActivitySummary, summariseUpcoming } from "./activity-summary";

const ticket = (eventId: string, startsAt: string, title = `Event ${eventId}`): TicketView =>
  ({
    id: `t-${eventId}-${Math.random()}`,
    eventId,
    event: { id: eventId, title, startsAt, venue: "Vicar St", city: "Dublin", artworkUrl: null, sellerDisplayName: "S" },
  }) as unknown as TicketView;

const NOW = new Date("2026-12-01T12:00:00Z");

describe("summariseUpcoming", () => {
  it("groups tickets by event, drops past events and sorts soonest first", () => {
    const result = summariseUpcoming(
      [
        ticket("b", "2026-12-20T20:00:00Z"),
        ticket("a", "2026-12-05T20:00:00Z"),
        ticket("b", "2026-12-20T20:00:00Z"),
        ticket("old", "2026-11-01T20:00:00Z"),
      ],
      NOW,
    );
    expect(result.map((e) => [e.eventId, e.tickets])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});

describe("ActivitySummary (XRPL-056)", () => {
  const upcoming = [
    { eventId: "a", title: "Night Market", startsAt: "2026-12-05T20:00:00Z", venue: "Vicar St", city: "Dublin", tickets: 2 },
  ];
  const attended = [
    { eventId: "p", title: "Last Gig", startsAt: "2026-11-01T20:00:00Z", venue: "Button Factory", city: "Dublin", checkedInAt: "2026-11-01T19:30:00Z" },
  ];

  it("has sections for upcoming events, history, followed sellers and wishlist", () => {
    render(<ActivitySummary hasWallet upcoming={upcoming} attended={attended} />);
    for (const heading of ["Upcoming events", "Events you attended", "Sellers you follow", "Wishlist"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Night Market" })).toHaveAttribute("href", "/events/a");
    expect(screen.getByText("2 tickets")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all my tickets" })).toHaveAttribute("href", "/tickets");
    expect(screen.getByRole("link", { name: "Last Gig" })).toHaveAttribute("href", "/events/p");
  });

  it("asks for a wallet when none is connected", () => {
    render(<ActivitySummary hasWallet={false} upcoming={[]} attended={[]} />);
    expect(screen.getByRole("link", { name: "Connect your wallet" })).toHaveAttribute("href", "/connect");
  });

  it("shows empty states", () => {
    render(<ActivitySummary hasWallet upcoming={[]} attended={[]} />);
    expect(screen.getByText(/No tickets for upcoming events/)).toBeInTheDocument();
    expect(screen.getByText(/once you're checked in at the door/)).toBeInTheDocument();
  });

  it("says when something couldn't be loaded instead of showing it as empty", () => {
    render(<ActivitySummary hasWallet upcoming={null} attended={null} />);
    const section = screen.getByRole("region", { name: "Your activity" });
    expect(within(section).getByText(/Couldn't check your wallet/)).toBeInTheDocument();
    expect(within(section).getByText(/Couldn't load your history/)).toBeInTheDocument();
    expect(within(section).queryByText(/No tickets/)).not.toBeInTheDocument();
  });
});
