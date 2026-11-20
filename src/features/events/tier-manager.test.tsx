import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventView, TicketTierView } from "@/contracts";
import { TierManager, draftToTierInput } from "./tier-manager";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const postJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/onboarding/post-json", () => ({ postJson }));

function tier(overrides: Partial<TicketTierView> = {}): TicketTierView {
  return {
    id: "tier-1",
    eventId: "evt-1",
    name: "General admission",
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

function event(tiers: TicketTierView[]): EventView {
  return {
    id: "evt-1",
    seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    title: "Night Market Live",
    description: "",
    startsAt: "2026-12-01T20:00:00.000Z",
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "DRAFT",
    artworkUrl: null,
    tiers,
    publishedAt: null,
  };
}

describe("draftToTierInput", () => {
  const valid = { name: "GA", description: "", priceXrp: "25", quantity: "100" };

  it("converts a valid draft to drops", () => {
    const result = draftToTierInput(valid);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.priceDrops).toBe("25000000");
      expect(result.value.totalSupply).toBe(100);
    }
  });

  it("rejects a negative price and a negative quantity", () => {
    expect(draftToTierInput({ ...valid, priceXrp: "-5" })).toMatchObject({ ok: false });
    expect(draftToTierInput({ ...valid, quantity: "-10" })).toMatchObject({ ok: false });
  });

  it("rejects a fractional or exponential quantity", () => {
    // Number("2.5") and Number("1e3") both parse, so these need their own check.
    expect(draftToTierInput({ ...valid, quantity: "2.5" })).toMatchObject({ ok: false });
    expect(draftToTierInput({ ...valid, quantity: "1e3" })).toMatchObject({ ok: false });
  });

  it("rejects a zero quantity but allows a free tier", () => {
    expect(draftToTierInput({ ...valid, quantity: "0" })).toMatchObject({ ok: false });
    expect(draftToTierInput({ ...valid, priceXrp: "0" })).toMatchObject({ ok: true });
  });

  it("rejects missing required values", () => {
    expect(draftToTierInput({ ...valid, name: "  " })).toMatchObject({ ok: false });
    expect(draftToTierInput({ ...valid, priceXrp: "" })).toMatchObject({ ok: false });
    expect(draftToTierInput({ ...valid, quantity: "" })).toMatchObject({ ok: false });
  });

  it("reports every invalid field at once", () => {
    const result = draftToTierInput({ name: "", description: "", priceXrp: "x", quantity: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["name", "priceXrp", "quantity"]);
    }
  });

  it("enforces the contract's upper quantity bound", () => {
    expect(draftToTierInput({ ...valid, quantity: "10000" })).toMatchObject({ ok: true });
    expect(draftToTierInput({ ...valid, quantity: "10001" })).toMatchObject({ ok: false });
  });
});

describe("TierManager", () => {
  beforeEach(() => {
    router.refresh.mockReset();
    postJson.mockReset();
  });

  it("prompts for a first tier when the event has none", () => {
    render(<TierManager event={event([])} />);
    expect(screen.getByText(/No tiers yet/)).toBeVisible();
  });

  it("adds a tier, sending XRP converted to drops", async () => {
    postJson.mockResolvedValue({ ok: true, data: event([tier()]) });
    const user = userEvent.setup();
    render(<TierManager event={event([])} />);

    await user.type(screen.getByLabelText(/Tier name/), "General admission");
    await user.type(screen.getByLabelText(/Price in XRP/), "25");
    await user.type(screen.getByLabelText(/Quantity/), "100");
    await user.click(screen.getByRole("button", { name: "Add tier" }));

    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, body] = postJson.mock.calls[0]!;
    expect(url).toBe("/api/events/evt-1/tiers");
    expect(body).toMatchObject({
      name: "General admission",
      priceDrops: "25000000",
      totalSupply: 100,
    });
  });

  it("does not submit an invalid price or quantity", async () => {
    const user = userEvent.setup();
    render(<TierManager event={event([])} />);

    await user.type(screen.getByLabelText(/Tier name/), "GA");
    await user.type(screen.getByLabelText(/Price in XRP/), "-5");
    await user.type(screen.getByLabelText(/Quantity/), "abc");
    await user.click(screen.getByRole("button", { name: "Add tier" }));

    expect(postJson).not.toHaveBeenCalled();
    expect(screen.getByText("Price cannot be negative")).toBeVisible();
    expect(screen.getByText("Enter a whole number of tickets")).toBeVisible();
  });

  it("shows a duplicate-name conflict from the server and keeps the input", async () => {
    postJson.mockResolvedValue({
      ok: false,
      code: "DUPLICATE_TIER_NAME",
      message: 'This event already has a tier called "GA"',
    });
    const user = userEvent.setup();
    render(<TierManager event={event([tier({ name: "GA" })])} />);

    await user.type(screen.getByLabelText(/Tier name/), "GA");
    await user.type(screen.getByLabelText(/Price in XRP/), "10");
    await user.type(screen.getByLabelText(/Quantity/), "5");
    await user.click(screen.getByRole("button", { name: "Add tier" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already has a tier called");
    expect(screen.getByLabelText(/Tier name/)).toHaveValue("GA");
  });

  it("lists an existing tier with its price and counts", () => {
    render(<TierManager event={event([tier({ mintedQuantity: 40 })])} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText(/25 XRP/)).toBeVisible();
    expect(within(item).getByText(/100 tickets/)).toBeVisible();
    expect(within(item).getByText(/40 minted/)).toBeVisible();
  });

  it("marks a minted tier as price-fixed and blocks removal", () => {
    render(<TierManager event={event([tier({ mintedQuantity: 1, locked: true })])} />);
    expect(screen.getByText("Minted — price fixed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("allows removal while no tickets exist", () => {
    render(<TierManager event={event([tier()])} />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("disables the price field when editing a locked tier but allows the name", async () => {
    const user = userEvent.setup();
    render(<TierManager event={event([tier({ mintedQuantity: 1, locked: true })])} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // Scoped to the row: the "Add a tier" form has fields with the same labels.
    const row = within(screen.getByRole("listitem"));
    expect(row.getByLabelText(/Price in XRP/)).toBeDisabled();
    expect(row.getByLabelText(/Tier name/)).toBeEnabled();
    expect(row.getByText(/already on the ledger/)).toBeVisible();
  });

  it("pre-fills the edit form with the tier's current XRP price", async () => {
    const user = userEvent.setup();
    render(<TierManager event={event([tier({ priceDrops: "2500000", totalSupply: 50 })])} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const row = within(screen.getByRole("listitem"));
    expect(row.getByLabelText(/Price in XRP/)).toHaveValue("2.5");
    expect(row.getByLabelText(/Quantity/)).toHaveValue("50");
  });

  it("keeps the add form's price field usable while a locked tier is being edited", async () => {
    const user = userEvent.setup();
    render(<TierManager event={event([tier({ mintedQuantity: 1, locked: true })])} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // The lock applies to that one tier, not to adding a new one.
    const addForm = within(screen.getByRole("form", { name: /Add a tier/i }));
    expect(addForm.getByLabelText(/Price in XRP/)).toBeEnabled();
  });

  it("totals the tickets across tiers", () => {
    render(
      <TierManager
        event={event([
          tier({ id: "t1", name: "GA", totalSupply: 100 }),
          tier({ id: "t2", name: "VIP", totalSupply: 20 }),
        ])}
      />,
    );
    expect(screen.getByText(/120 tickets total/)).toBeVisible();
  });
});
