import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EventMetrics } from "@/contracts/checkin";
import { CheckInTimeline, niceTicks } from "./checkin-timeline";
import { bucketCheckIns } from "./metrics";
import { MetricTiles, PendingActivity, metricTiles } from "./metric-tiles";

const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00.000Z`);

describe("bucketCheckIns", () => {
  it("returns nothing for no check-ins", () => {
    expect(bucketCheckIns([])).toEqual({ bucketMinutes: 15, timeline: [] });
  });

  it("uses 5-minute buckets for a short window and keeps empty buckets", () => {
    const { bucketMinutes, timeline } = bucketCheckIns([at("20:01"), at("20:03"), at("20:16")]);
    expect(bucketMinutes).toBe(5);
    expect(timeline.map((b) => [b.start.slice(11, 16), b.count])).toEqual([
      ["20:00", 2],
      ["20:05", 0],
      ["20:10", 0],
      ["20:15", 1],
    ]);
  });

  it("widens buckets so a long evening stays readable (<= 32 bars)", () => {
    const { bucketMinutes, timeline } = bucketCheckIns([at("18:00"), at("23:50")]);
    expect(bucketMinutes).toBe(15);
    expect(timeline.length).toBeLessThanOrEqual(32);
    expect(timeline.reduce((n, b) => n + b.count, 0)).toBe(2);
  });
});

describe("niceTicks", () => {
  it("produces clean, small tick sets", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(130)).toEqual([0, 50, 100, 150]);
  });
});

const metrics: EventMetrics = {
  eventId: "e",
  ticketsTotal: 4,
  primarySold: 4,
  primaryRevenueDrops: "17500000",
  resales: 1,
  resaleVolumeDrops: "3000000",
  privateTransfers: 1,
  gifts: 2,
  checkedIn: 3,
  notCheckedIn: 1,
  pending: { purchases: 2, listings: 1, mints: 0 },
  checkInTimeline: [
    { start: "2026-12-01T20:00:00.000Z", count: 2 },
    { start: "2026-12-01T20:05:00.000Z", count: 0 },
    { start: "2026-12-01T20:10:00.000Z", count: 1 },
  ],
  bucketMinutes: 5,
  calculatedAt: "2026-12-01T21:00:00.000Z",
};

describe("MetricTiles", () => {
  it("formats XRP from drops and percentages", () => {
    const tiles = Object.fromEntries(metricTiles(metrics).map((t) => [t.label, t]));
    expect(tiles["Tickets sold"]).toMatchObject({ value: "4", detail: "of 4 (100%)" });
    expect(tiles["Primary revenue"]!.value).toBe("17.5 XRP");
    expect(tiles["Resales"]).toMatchObject({ value: "1", detail: "3 XRP volume" });
    expect(tiles["Checked in"]).toMatchObject({ value: "3", detail: "75% of tickets sold" });
    expect(tiles["Private transfers"]).toMatchObject({ value: "1", detail: "2 gifts" });
  });

  it("does not divide by zero", () => {
    const tiles = metricTiles({ ...metrics, ticketsTotal: 0, primarySold: 0, checkedIn: 0 });
    expect(tiles[0]!.detail).toBe("of 0 (–)");
    expect(tiles[3]!.detail).toBe("– of tickets sold");
  });

  it("renders every tile", () => {
    render(<MetricTiles metrics={metrics} />);
    expect(screen.getByText("Primary revenue")).toBeInTheDocument();
    expect(screen.getByText("17.5 XRP")).toBeInTheDocument();
  });
});

describe("PendingActivity", () => {
  it("lists pending items separately from confirmed figures", () => {
    render(<PendingActivity pending={metrics.pending} />);
    const section = screen.getByRole("region", { name: "Waiting for the XRP Ledger" });
    expect(section).toHaveTextContent("Not counted in the figures above");
    expect(within(section).getByText("Purchases awaiting confirmation").nextSibling).toHaveTextContent("2");
    expect(within(section).getByText("Listings awaiting wallet signature").nextSibling).toHaveTextContent("1");
  });

  it("says when nothing is pending", () => {
    render(<PendingActivity pending={{ purchases: 0, listings: 0, mints: 0 }} />);
    expect(screen.getByText("Nothing pending right now.")).toBeInTheDocument();
  });
});

describe("CheckInTimeline", () => {
  it("draws a bar per non-empty bucket and names the peak", () => {
    const { container } = render(<CheckInTimeline metrics={metrics} />);
    expect(container.querySelectorAll("path")).toHaveLength(2);
    // The chart is one image with a summary; each bar is a named image inside it.
    expect(screen.getByRole("img", { name: /Peak 2 at 20:00 UTC/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 check-ins, 20:00 to 20:05 UTC" })).toHaveAttribute("tabindex", "0");
  });

  it("shows a tooltip on keyboard focus, with value first", () => {
    render(<CheckInTimeline metrics={metrics} />);
    const bar = screen.getByLabelText("1 check-ins, 20:10 to 20:15 UTC");
    fireEvent.focus(bar);
    const tip = screen.getByRole("status");
    expect(within(tip).getByText("1 check-ins").tagName).toBe("STRONG");
    expect(tip).toHaveTextContent("20:10–20:15 UTC");
    fireEvent.blur(bar);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("has a table view with every bucket", () => {
    render(<CheckInTimeline metrics={metrics} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent("20:101");
  });

  it("has an empty state", () => {
    render(<CheckInTimeline metrics={{ checkInTimeline: [], bucketMinutes: 15 }} />);
    expect(screen.getByText("No check-ins yet.")).toBeInTheDocument();
  });
});
