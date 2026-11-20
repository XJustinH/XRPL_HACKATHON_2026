import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { EventInventory } from "@/contracts/checkin";
import { InventoryTable } from "./inventory-table";

const inventory: EventInventory = {
  eventId: "e",
  tiers: [
    { tierId: "t1", name: "GA", priceDrops: "2500000", total: 3, minted: 3, minting: 0, onSale: 1, sold: 1, unsold: 2 },
    { tierId: "t2", name: "VIP", priceDrops: "10000000", total: 2, minted: 0, minting: 1, onSale: 0, sold: 0, unsold: 2 },
  ],
  totals: { total: 5, minted: 3, minting: 1, onSale: 1, sold: 1, unsold: 4 },
  primarySoldOut: false,
  checkedIn: 0,
  calculatedAt: "2026-12-01T20:00:00.000Z",
};

describe("InventoryTable", () => {
  it("shows every tier's counts and the totals row", () => {
    render(<InventoryTable inventory={inventory} />);
    const table = screen.getByRole("table", { name: "Ticket inventory by tier" });
    const ga = within(table).getByRole("row", { name: /GA/ });
    expect(within(ga).getAllByRole("cell").map((c) => c.textContent)).toEqual(["3", "3", "1", "1", "2"]);
    const totals = within(table).getByRole("row", { name: /All tiers/ });
    expect(within(totals).getAllByRole("cell").map((c) => c.textContent)).toEqual(["5", "3", "1", "1", "4"]);
    expect(within(table).getByText("1 minting")).toBeInTheDocument();
    expect(within(table).getByText("2.5 XRP")).toBeInTheDocument();
  });

  it("has a card per tier for small screens", () => {
    render(<InventoryTable inventory={inventory} />);
    const cards = within(screen.getByRole("list", { name: "Ticket tiers" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[1]!).getByText("1 minting, waiting for XRPL")).toBeInTheDocument();
  });

  it("has an empty state", () => {
    render(<InventoryTable inventory={{ ...inventory, tiers: [] }} />);
    expect(screen.getByText("No ticket tiers yet.")).toBeInTheDocument();
  });
});
