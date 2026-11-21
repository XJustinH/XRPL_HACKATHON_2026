import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { CollectibleMetrics, MerchandiseMetrics } from "@/contracts/analytics";
import {
  CollectiblesSection,
  MerchandiseSection,
  TicketSummarySection,
  ledgerCheckText,
} from "./storefront-sections";

const HASH = "E".repeat(64);

const merchandise = (over: Partial<MerchandiseMetrics> = {}): MerchandiseMetrics => ({
  currency: "XRP",
  settlement: "SIMULATED",
  orders: 3,
  byStatus: [
    { status: "NEW", orders: 1, units: 2, totalDrops: "30000000" },
    { status: "PROCESSING", orders: 0, units: 0, totalDrops: "0" },
    { status: "SHIPPED", orders: 1, units: 1, totalDrops: "4000000" },
    { status: "FULFILLED", orders: 0, units: 0, totalDrops: "0" },
    { status: "CANCELLED", orders: 1, units: 5, totalDrops: "75000000" },
  ],
  ordersCounted: 2,
  unitsSold: 3,
  orderValueDrops: "34000000",
  cancelledDrops: "75000000",
  reconciliation: { orderTotalsDrops: "109000000", lineTotalsDrops: "109000000", mismatchedOrderIds: [], reconciled: true },
  ...over,
});

const collectibles = (over: Partial<CollectibleMetrics> = {}): CollectibleMetrics => ({
  currency: "XRP",
  settlement: "XRPL",
  networkLabel: "XRPL Testnet",
  listings: 1,
  editions: 3,
  minted: 2,
  forSale: 1,
  sold: 1,
  revenueDrops: "5000000",
  pending: { mints: 0, listings: 0, purchases: 1 },
  notCompleted: { failedMints: 0, failedListings: 0, staleOffers: 2 },
  reconciliation: { salesWithTransaction: 1, salesWithTransactionDrops: "5000000", reconciled: true },
  sales: [
    {
      tokenId: "t1",
      collectibleId: "c1",
      title: "Tour poster",
      edition: 1,
      editionSize: 3,
      nftokenId: "A".repeat(64),
      amountDrops: "5000000",
      soldAt: "2026-11-21T10:05:00.000Z",
      txHash: HASH,
      explorerUrl: `https://testnet.xrpl.org/transactions/${HASH}`,
    },
  ],
  salesTruncated: false,
  ...over,
});

describe("MerchandiseSection", () => {
  it("names the currency and that payment is simulated, and lists every order status", () => {
    render(<MerchandiseSection merchandise={merchandise()} />);
    const section = screen.getByRole("region", { name: "Physical merchandise" });
    expect(within(section).getByText("Simulated payment")).toBeInTheDocument();
    expect(within(section).getByText("34 XRP")).toBeInTheDocument();

    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "New1230 XRP",
      "Processing000 XRP",
      "Shipped114 XRP",
      "Fulfilled000 XRP",
      "Cancelled (not counted)1575 XRP",
    ]);
    expect(within(section).getByText("Reconciled.")).toBeInTheDocument();
    expect(section).toHaveTextContent("The totals of all 3 orders come to 109 XRP, the same as the sum of their order lines.");
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("raises an alert naming the orders whose totals do not match their lines", () => {
    render(
      <MerchandiseSection
        merchandise={merchandise({
          reconciliation: {
            orderTotalsDrops: "108000000",
            lineTotalsDrops: "109000000",
            mismatchedOrderIds: ["order-7"],
            reconciled: false,
          },
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Does not reconcile.");
    expect(alert).toHaveTextContent("108 XRP");
    expect(alert).toHaveTextContent("109 XRP");
    expect(alert).toHaveTextContent("order-7");
  });
});

describe("CollectiblesSection", () => {
  it("shows validated sales with their transactions, apart from pending and uncompleted ones", () => {
    render(
      <CollectiblesSection
        collectibles={collectibles()}
        checks={[{ txHash: HASH, outcome: "VALIDATED", ledgerIndex: 1234 }]}
      />,
    );
    const section = screen.getByRole("region", { name: "Digital collectibles" });
    expect(within(section).getByText("Validated on XRPL Testnet")).toBeInTheDocument();
    expect(within(section).getByText("Purchases awaiting confirmation").nextElementSibling).toHaveTextContent("1");
    expect(within(section).getByText(/2 sell offers no longer on the ledger/)).toBeInTheDocument();

    // Each sale is a list item (a table's fourth column would be off a phone's screen), and the link's
    // name starts with what it is and still contains the shortened hash that is shown.
    const sale = within(within(section).getByRole("list", { name: "Sales behind this total" })).getByRole("listitem");
    const link = within(sale).getByRole("link", { name: "Purchase transaction EEEEEEEE…EEEEEE" });
    expect(link).toHaveAttribute("href", `https://testnet.xrpl.org/transactions/${HASH}`);
    expect(within(sale).getByText("Checked on the ledger (ledger 1234)")).toBeInTheDocument();
    expect(within(sale).getByText("Sold 2026-11-21 10:05 UTC")).toBeInTheDocument();
    expect(within(sale).getByText("5 XRP")).toBeInTheDocument();
    expect(within(section).getByText("Reconciled.")).toBeInTheDocument();
    expect(section).toHaveTextContent("The sale carries the hash of a validated purchase transaction, for 5 XRP.");
  });

  it("raises an alert when the ledger contradicts a recorded sale, or a sale has no transaction", () => {
    const { unmount } = render(
      <CollectiblesSection collectibles={collectibles()} checks={[{ txHash: HASH, outcome: "MISMATCH", ledgerIndex: null }]} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The ledger does not match 1 recorded sale.");
    unmount();

    render(
      <CollectiblesSection
        collectibles={collectibles({
          sold: 2,
          revenueDrops: "10000000",
          reconciliation: { salesWithTransaction: 1, salesWithTransactionDrops: "5000000", reconciled: false },
        })}
        checks={[]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("1 sale of 2 have no validated transaction recorded.");
  });

  it("says so when nothing has been sold", () => {
    render(
      <CollectiblesSection
        collectibles={collectibles({
          sold: 0,
          revenueDrops: "0",
          sales: [],
          reconciliation: { salesWithTransaction: 0, salesWithTransactionDrops: "0", reconciled: true },
        })}
        checks={[]}
      />,
    );
    expect(screen.getByText("No collectible has been sold yet.")).toBeInTheDocument();
    expect(screen.getByText("There are no sales to check yet.")).toBeInTheDocument();
  });
});

describe("TicketSummarySection and ledgerCheckText", () => {
  it("summarises validated ticket sales and links to the per-event analytics", () => {
    render(
      <TicketSummarySection
        tickets={{ currency: "XRP", settlement: "XRPL", events: 2, sold: 5, revenueDrops: "12500000" }}
      />,
    );
    const section = screen.getByRole("region", { name: "Tickets" });
    expect(within(section).getByText("12.5 XRP")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: /event's analytics/ })).toHaveAttribute("href", "/seller/events");
  });

  it("never claims more than the ledger check found", () => {
    expect(ledgerCheckText(undefined)).toBe("Recorded from a validated transaction");
    expect(ledgerCheckText({ txHash: HASH, outcome: "UNAVAILABLE", ledgerIndex: null })).toBe(
      "Recorded as validated; the ledger could not be read again just now",
    );
    expect(ledgerCheckText({ txHash: HASH, outcome: "MISMATCH", ledgerIndex: null })).toBe(
      "The ledger does not match this record",
    );
  });
});
