import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventForm, localInputToUtcIso, utcIsoToLocalInput } from "./event-form";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const postJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/onboarding/post-json", () => ({ postJson }));

/** Fills every required field with valid input. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Event name/), "Night Market Live");
  await user.type(screen.getByLabelText(/^Starts/), "2026-12-01T20:00");
  await user.type(screen.getByLabelText(/Venue/), "Vicar Street");
  await user.type(screen.getByLabelText(/City/), "Dublin");
}

const submit = () => screen.getByRole("button", { name: "Save draft" });

describe("datetime conversion", () => {
  it("round-trips a local value through UTC", () => {
    const iso = localInputToUtcIso("2026-12-01T20:00");
    expect(iso).not.toBeNull();
    expect(utcIsoToLocalInput(iso)).toBe("2026-12-01T20:00");
  });

  it("produces an offset-bearing ISO string the contract accepts", () => {
    expect(localInputToUtcIso("2026-12-01T20:00")).toMatch(/Z$/);
  });

  it("returns null for empty or unparseable input", () => {
    expect(localInputToUtcIso("")).toBeNull();
    expect(localInputToUtcIso("not-a-date")).toBeNull();
    expect(utcIsoToLocalInput(null)).toBe("");
  });
});

describe("EventForm", () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    postJson.mockReset();
    postJson.mockResolvedValue({ ok: true, data: { id: "evt-1" } });
  });

  it("creates a draft and returns the seller to their events", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.click(submit());

    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, body] = postJson.mock.calls[0]!;
    expect(url).toBe("/api/events");
    expect(body).toMatchObject({
      title: "Night Market Live",
      venue: "Vicar Street",
      city: "Dublin",
    });
    expect(body.startsAt).toMatch(/Z$/);
    expect(router.push).toHaveBeenCalledWith("/seller/events");
  });

  it("sends the chosen category, or null for No category", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<EventForm />);
    await fillRequired(user);
    await user.selectOptions(screen.getByLabelText("Category"), "FOOD");
    await user.click(submit());
    expect(postJson.mock.calls[0]![1]).toMatchObject({ category: "FOOD" });
    unmount();

    render(<EventForm />);
    await fillRequired(user);
    await user.click(submit());
    expect(postJson.mock.calls[1]![1]).toMatchObject({ category: null });
  });

  it("blocks submission and reports every missing required field", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await user.click(submit());

    expect(postJson).not.toHaveBeenCalled();
    expect(screen.getByText("Start date and time is required")).toBeVisible();
    expect(screen.getByLabelText(/Event name/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Venue/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/City/)).toHaveAttribute("aria-invalid", "true");
  });

  it("links each message to its field for assistive technology", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await user.click(submit());

    const title = screen.getByLabelText(/Event name/);
    const describedBy = title.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/at least 3 characters/i);
  });

  it("rejects an end time that is not after the start time", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^Ends/), "2026-12-01T19:00");
    await user.click(submit());

    expect(postJson).not.toHaveBeenCalled();
    expect(screen.getByText("End time must be after the start time")).toBeVisible();
  });

  it("rejects an end time equal to the start time", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^Ends/), "2026-12-01T20:00");
    await user.click(submit());

    expect(postJson).not.toHaveBeenCalled();
    expect(screen.getByText("End time must be after the start time")).toBeVisible();
  });

  it("accepts a valid end time", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^Ends/), "2026-12-01T23:30");
    await user.click(submit());

    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson.mock.calls[0]![1].endsAt).toMatch(/Z$/);
  });

  it("rejects a title shorter than the contract allows", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await user.type(screen.getByLabelText(/Event name/), "Hi");
    await user.type(screen.getByLabelText(/^Starts/), "2026-12-01T20:00");
    await user.type(screen.getByLabelText(/Venue/), "Vicar Street");
    await user.type(screen.getByLabelText(/City/), "Dublin");
    await user.click(submit());

    expect(postJson).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Event name/)).toHaveAttribute("aria-invalid", "true");
  });

  it("rejects artwork that is not a URL but allows it to be left empty", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/Artwork URL/), "example.com");
    await user.click(submit());
    expect(postJson).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/Artwork URL/));
    await user.click(submit());
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server error without navigating away", async () => {
    postJson.mockResolvedValue({
      ok: false,
      code: "ROLE_REQUIRED",
      message: "Your account type can't do this.",
    });
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent("Your account type can't do this.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps everything the seller typed when the server rejects the request", async () => {
    postJson.mockResolvedValue({ ok: false, code: "ROLE_REQUIRED", message: "Not allowed." });
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/Description/), "Doors at seven");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toBeVisible();
    // A form reset here would make the seller retype the whole event.
    expect(screen.getByLabelText(/Event name/)).toHaveValue("Night Market Live");
    expect(screen.getByLabelText(/^Starts/)).toHaveValue("2026-12-01T20:00");
    expect(screen.getByLabelText(/Venue/)).toHaveValue("Vicar Street");
    expect(screen.getByLabelText(/City/)).toHaveValue("Dublin");
    expect(screen.getByLabelText(/Description/)).toHaveValue("Doors at seven");
  });

  it("retries successfully after a failure without the seller re-entering anything", async () => {
    postJson.mockResolvedValueOnce({ ok: false, code: "INTERNAL", message: "Server error." });
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toBeVisible();

    postJson.mockResolvedValueOnce({ ok: true, data: { id: "evt-1" } });
    await user.click(submit());

    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls[1]![1]).toMatchObject({ title: "Night Market Live" });
    expect(router.push).toHaveBeenCalledWith("/seller/events");
  });

  it("re-enables the submit button after a failure so the seller can retry", async () => {
    postJson.mockResolvedValue({ ok: false, code: "NETWORK_ERROR", message: "Couldn't reach the server." });
    const user = userEvent.setup();
    render(<EventForm />);
    await fillRequired(user);
    await user.click(submit());

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(submit()).toBeEnabled();
  });

  it("clears stale field errors once the input is corrected", async () => {
    const user = userEvent.setup();
    render(<EventForm />);
    await user.click(submit());
    expect(screen.getByText("Start date and time is required")).toBeVisible();

    await fillRequired(user);
    await user.click(submit());

    expect(screen.queryByText("Start date and time is required")).not.toBeInTheDocument();
    expect(postJson).toHaveBeenCalledTimes(1);
  });
});
