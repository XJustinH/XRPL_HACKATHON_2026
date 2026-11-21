import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventView, TicketTierView } from "@/contracts";
import { PublishPanel } from "./publish-panel";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const requestJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./api-client", () => ({ requestJson }));

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
    // Far enough ahead that the real clock cannot make this test flaky.
    startsAt: "2099-12-01T20:00:00.000Z",
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "DRAFT",
    artworkUrl: null,
    category: null,
    tiers: [tier()],
    publishedAt: null,
    ...overrides,
  };
}

describe("PublishPanel", () => {
  beforeEach(() => {
    router.refresh.mockReset();
    requestJson.mockReset();
    requestJson.mockResolvedValue({ ok: true, data: event({ status: "PUBLISHED" }) });
  });

  it("publishes a complete draft", async () => {
    const user = userEvent.setup();
    render(<PublishPanel event={event()} />);

    await user.click(screen.getByRole("button", { name: "Publish event" }));

    expect(requestJson).toHaveBeenCalledWith("/api/events/evt-1/publish", { method: "POST" });
    expect(screen.getByText("Published")).toBeVisible();
  });

  it("explains that a draft is private", () => {
    render(<PublishPanel event={event()} />);
    expect(screen.getByText(/Drafts are private/)).toBeVisible();
    expect(screen.getByText("Draft")).toBeVisible();
  });

  it("blocks publishing an event with no tiers and says why", async () => {
    const user = userEvent.setup();
    render(<PublishPanel event={event({ tiers: [] })} />);

    const button = screen.getByRole("button", { name: "Publish event" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Add at least one ticket tier/)).toBeVisible();

    await user.click(button);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("blocks publishing an event whose start time has passed", () => {
    render(<PublishPanel event={event({ startsAt: "2020-01-01T20:00:00.000Z" })} />);
    expect(screen.getByRole("button", { name: "Publish event" })).toBeDisabled();
    expect(screen.getByText(/start time has already passed/)).toBeVisible();
  });

  it("shows the server's blocker list when it disagrees with the client", async () => {
    requestJson.mockResolvedValue({
      ok: false,
      code: "NOT_PUBLISHABLE",
      message: "This event is not ready to publish",
      details: {
        blockers: [{ code: "NO_SUPPLY", message: "At least one tier needs a quantity." }],
      },
    });
    const user = userEvent.setup();
    render(<PublishPanel event={event()} />);

    await user.click(screen.getByRole("button", { name: "Publish event" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not ready to publish");
    expect(screen.getByText("At least one tier needs a quantity.")).toBeVisible();
  });

  it("offers a return to draft for a published event with no minted tickets", () => {
    render(<PublishPanel event={event({ status: "PUBLISHED" })} />);
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeEnabled();
    expect(screen.getByText(/listed publicly/)).toBeVisible();
  });

  it("refuses to hide a published event once tickets are on the ledger", () => {
    render(
      <PublishPanel
        event={event({ status: "PUBLISHED", tiers: [tier({ mintedQuantity: 3 })] })}
      />,
    );
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeDisabled();
    expect(screen.getByText(/stays public/)).toBeVisible();
    expect(screen.getByText("3 tickets minted")).toBeVisible();
  });

  it("returns a published event to draft", async () => {
    requestJson.mockResolvedValue({ ok: true, data: event({ status: "DRAFT" }) });
    const user = userEvent.setup();
    render(<PublishPanel event={event({ status: "PUBLISHED" })} />);

    await user.click(screen.getByRole("button", { name: "Return to draft" }));

    expect(requestJson).toHaveBeenCalledWith("/api/events/evt-1/unpublish", { method: "POST" });
    expect(screen.getByRole("button", { name: "Publish event" })).toBeVisible();
  });

  it("surfaces a network failure without changing the displayed state", async () => {
    requestJson.mockResolvedValue({
      ok: false,
      code: "NETWORK_ERROR",
      message: "Couldn't reach the server.",
    });
    const user = userEvent.setup();
    render(<PublishPanel event={event()} />);

    await user.click(screen.getByRole("button", { name: "Publish event" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server.");
    expect(screen.getByText("Draft")).toBeVisible();
  });

  it("shows the singular form for a single minted ticket", () => {
    render(
      <PublishPanel
        event={event({ status: "PUBLISHED", tiers: [tier({ mintedQuantity: 1 })] })}
      />,
    );
    expect(screen.getByText("1 ticket minted")).toBeVisible();
  });

  it("picks up a tier added after the page loaded, without a reload", () => {
    // The tier manager adds a tier, then router.refresh() re-renders the page with the new event.
    const { rerender } = render(<PublishPanel event={event({ tiers: [] })} />);
    expect(screen.getByRole("button", { name: "Publish event" })).toBeDisabled();

    rerender(<PublishPanel event={event()} />);

    expect(screen.getByRole("button", { name: "Publish event" })).toBeEnabled();
  });
});
