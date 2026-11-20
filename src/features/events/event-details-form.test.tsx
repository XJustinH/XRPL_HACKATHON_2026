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

    it("freezes the fields written into NFT metadata", () => {
      render(<EventDetailsForm event={minted} />);
      for (const label of ["Event name", "Starts", "Ends", "Venue", "City", "Artwork URL"]) {
        expect(screen.getByLabelText(label), `${label} must be frozen`).toBeDisabled();
      }
    });

    it("keeps the description editable and explains the restriction", () => {
      render(<EventDetailsForm event={minted} />);
      expect(screen.getByLabelText("Description")).toBeEnabled();
      expect(screen.getByText(/already on the ledger/)).toBeVisible();
    });

    it("sends only the description, never a frozen field", async () => {
      const user = userEvent.setup();
      render(<EventDetailsForm event={minted} />);

      await user.clear(screen.getByLabelText("Description"));
      await user.type(screen.getByLabelText("Description"), "Updated blurb");
      await user.click(save());

      const [, init] = requestJson.mock.calls[0]!;
      expect(init.body).toEqual({ description: "Updated blurb" });
      expect(init.body).not.toHaveProperty("title");
      expect(init.body).not.toHaveProperty("startsAt");
    });

    it("does not send endsAt when only the description changed", async () => {
      // EventPatch defaults endsAt to null, which would read as clearing a set
      // end time and be refused as a frozen-field change.
      const withEnd = event({
        tiers: [tier(5)],
        endsAt: "2099-12-01T23:30:00.000Z",
      });
      const user = userEvent.setup();
      render(<EventDetailsForm event={withEnd} />);

      await user.type(screen.getByLabelText("Description"), " extra");
      await user.click(save());

      const [, init] = requestJson.mock.calls[0]!;
      expect(init.body).not.toHaveProperty("endsAt");
    });

    it("shows the server's refusal if a frozen field is somehow submitted", async () => {
      requestJson.mockResolvedValue({
        ok: false,
        code: "FIELDS_LOCKED_BY_MINT",
        message: "Tickets for this event are already on the ledger, so the venue cannot be changed.",
        details: { fields: ["venue"] },
      });
      const user = userEvent.setup();
      render(<EventDetailsForm event={minted} />);

      await user.type(screen.getByLabelText("Description"), " more");
      await user.click(save());

      expect(await screen.findByRole("alert")).toHaveTextContent("already on the ledger");
    });
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
