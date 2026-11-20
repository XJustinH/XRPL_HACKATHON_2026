import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TicketView } from "@/contracts";
import { TicketCard } from "./ticket-card";

function ticket(overrides: Partial<TicketView> = {}): TicketView {
  return {
    id: "tkt-1",
    eventId: "evt-1",
    tierId: "tier-1",
    serial: 7,
    tierName: "General admission",
    priceDrops: "25000000",
    event: {
      id: "evt-1",
      title: "Night Market Live",
      startsAt: "2099-12-01T20:00:00.000Z",
      venue: "Vicar Street",
      city: "Dublin",
      artworkUrl: null,
      sellerDisplayName: "Night Market",
    },
    ledger: {
      nftokenId: "A".repeat(64),
      issuerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      ownerAddress: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
      mintTxHash: "B".repeat(64),
      lastTransferTxHash: null,
      metadataUri: "https://example.com/t/tkt-1",
      ledgerIndex: 1234,
      verifiedAt: "2026-11-20T12:00:00.000Z",
      explorerTxUrl: "https://testnet.xrpl.org/transactions/BBB",
      explorerNftUrl: "https://testnet.xrpl.org/nft/AAA",
    },
    checkedInAt: null,
    ownedByViewer: true,
    ...overrides,
  };
}

describe("TicketCard", () => {
  it("shows date, venue, tier and serial", () => {
    render(<TicketCard ticket={ticket()} />);
    expect(screen.getByText("Night Market Live")).toBeVisible();
    expect(screen.getByText(/1 Dec 2099/)).toBeVisible();
    expect(screen.getByText("Vicar Street, Dublin")).toBeVisible();
    expect(screen.getByText("General admission")).toBeVisible();
    expect(screen.getByText(/#7/)).toBeVisible();
  });

  it("links to the ticket's own page", () => {
    render(<TicketCard ticket={ticket({ id: "abc-123" })} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/tickets/abc-123");
  });

  it("marks an unused ticket for an upcoming event as valid", () => {
    render(<TicketCard ticket={ticket()} />);
    expect(screen.getByText("Valid")).toBeVisible();
  });

  it("marks a checked-in ticket and says when it was used", () => {
    render(<TicketCard ticket={ticket({ checkedInAt: "2099-12-01T19:30:00.000Z" })} />);
    expect(screen.getByText("Checked in")).toBeVisible();
    expect(screen.getByText(/Entered/)).toBeVisible();
  });

  it("distinguishes a past ticket that was never used", () => {
    render(
      <TicketCard
        ticket={ticket({
          event: { ...ticket().event, startsAt: "2020-01-01T20:00:00.000Z" },
        })}
      />,
    );
    expect(screen.getByText("Not used")).toBeVisible();
    expect(screen.queryByText("Valid")).not.toBeInTheDocument();
  });

  it("still reports a past ticket as checked in when it was used", () => {
    render(
      <TicketCard
        ticket={ticket({
          checkedInAt: "2020-01-01T19:30:00.000Z",
          event: { ...ticket().event, startsAt: "2020-01-01T20:00:00.000Z" },
        })}
      />,
    );
    expect(screen.getByText("Checked in")).toBeVisible();
    expect(screen.queryByText("Not used")).not.toBeInTheDocument();
  });

  it("renders event artwork when present", () => {
    render(
      <TicketCard
        ticket={ticket({
          event: { ...ticket().event, artworkUrl: "https://example.com/a.png" },
        })}
      />,
    );
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "src",
      "https://example.com/a.png",
    );
  });

  it("refuses to render artwork with an unsafe scheme", () => {
    // Re-checked at render, as everywhere else a stored URL reaches the DOM.
    render(
      <TicketCard
        ticket={ticket({
          event: { ...ticket().event, artworkUrl: "javascript:alert(1)" },
        })}
      />,
    );
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("N", { selector: "div" })).toBeVisible();
  });
});
