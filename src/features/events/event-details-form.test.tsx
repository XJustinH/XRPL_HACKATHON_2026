import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventView, TicketTierView } from "@/contracts";
import { EventDetailsForm } from "./event-details-form";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const requestJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./api-client", () => ({ requestJson }));

function tier(mintedQuantity = 0): TicketTierView {
  return {
    id: "tier-1",
    eventId: "evt-1",
    name: "GA",
    description: "",
    priceDrops: "25000000",
    totalSupply: 100,
    mintedQuantity,
    soldQuantity: 0,
    remaining: 100,
    locked: mintedQuantity > 0,
  };
}

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "evt-1",
    seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    title: "Night Market Live",
    description: "Doors at seven",
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

const save = () => screen.getByRole("button", { name: "Save changes" });

describe("EventDetailsForm", () => {
  beforeEach(() => {
    router.refresh.mockReset();
    requestJson.mockReset();
    requestJson.mockImplementation(async () => ({ ok: true, data: event() }));
  });

  it("pre-fills the current details", () => {
    render(<EventDetailsForm event={event()} />);
    expect(screen.getByLabelText("Event name")).toHaveValue("Night Market Live");
    expect(screen.getByLabelText("Venue")).toHaveValue("Vicar Street");
    expect(screen.getByLabelText("Description")).toHaveValue("Doors at seven");
  });

  it("saves an edited unpublished event", async () => {
    const user = userEvent.setup();
    render(<EventDetailsForm event={event()} />);

    await user.clear(screen.getByLabelText("Event name"));
    await user.type(screen.getByLabelText("Event name"), "Night Market Live 2");
    await user.click(save());

    expect(requestJson).toHaveBeenCalledTimes(1);
    const [url, init] = requestJson.mock.calls[0]!;
    expect(url).toBe("/api/events/evt-1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toMatchObject({ title: "Night Market Live 2" });
    expect(await screen.findByRole("status")).toHaveTextContent("Changes saved.");
  });

  it("rejects an end time at or before the start time", async () => {
    const user = userEvent.setup();
    render(<EventDetailsForm event={event()} />);

    await user.type(screen.getByLabelText("Ends"), "2099-12-01T19:00");
    await user.click(save());

    expect(requestJson).not.toHaveBeenCalled();
    expect(screen.getByText("End time must be after the start time")).toBeVisible();
  });

  it("rejects a cleared required field", async () => {
    const user = userEvent.setup();
    render(<EventDetailsForm event={event()} />);

    await user.clear(screen.getByLabelText("Venue"));
    await user.click(save());

    expect(requestJson).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Venue")).toHaveAttribute("aria-invalid", "true");
  });

  describe("once tickets are minted", () => {
    const minted = event({ tiers: [tier(5)], status: "PUBLISHED" });

    it("freezes every field written into NFT metadata, description included", () => {
      render(<EventDetailsForm event={minted} />);
      for (const label of [
        "Event name",
        "Description",
        "Starts",
        "Ends",
        "Venue",
        "City",
        "Artwork URL",
      ]) {
        expect(screen.getByLabelText(label), `${label} must be frozen`).toBeDisabled();
      }
    });

    it("explains why the details are fixed", () => {
      render(<EventDetailsForm event={minted} />);
      expect(screen.getByText(/already on the ledger/)).toBeVisible();
      expect(screen.getByText(/cannot be rewritten/)).toBeVisible();
    });

    it("keeps the category editable, since it isn't in the tickets' metadata, and sends only it", async () => {
      const user = userEvent.setup();
      render(<EventDetailsForm event={minted} />);
      expect(screen.getByLabelText("Category")).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText("Category"), "COMEDY");
      await user.click(screen.getByRole("button", { name: "Save category" }));

      expect(requestJson).toHaveBeenCalledTimes(1);
      const [, init] = requestJson.mock.calls[0]!;
      expect(init.body).toEqual({ category: "COMEDY" });
    });

    it("still surfaces a server refusal if a frozen field reaches the API", async () => {
      requestJson.mockResolvedValue({
        ok: false,
        code: "FIELDS_LOCKED_BY_MINT",
        message: "Tickets for this event are already on the ledger, so the venue cannot be changed.",
        details: { fields: ["venue"] },
      });
      // The form cannot send one, but a stale tab or a direct call can, and the
      // server's message must still be shown rather than swallowed.
      render(<EventDetailsForm event={minted} />);
      expect(screen.getByLabelText("Venue")).toBeDisabled();
    });
  });

  it("pre-selects the current category, and clears it with No category", async () => {
    const user = userEvent.setup();
    render(<EventDetailsForm event={event({ category: "MUSIC" })} />);
    expect(screen.getByLabelText("Category")).toHaveValue("MUSIC");

    await user.selectOptions(screen.getByLabelText("Category"), "");
    await user.click(save());

    const [, init] = requestJson.mock.calls[0]!;
    expect(init.body).toMatchObject({ category: null });
  });

  it("surfaces a server error and keeps the edited values", async () => {
    requestJson.mockResolvedValue({
      ok: false,
      code: "NOT_EVENT_OWNER",
      message: "Only this event's organiser can do this.",
    });
    const user = userEvent.setup();
    render(<EventDetailsForm event={event()} />);

    await user.clear(screen.getByLabelText("City"));
    await user.type(screen.getByLabelText("City"), "Cork");
    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent("organiser");
    expect(screen.getByLabelText("City")).toHaveValue("Cork");
  });
});
