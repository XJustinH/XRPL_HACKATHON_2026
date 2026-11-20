import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EVENT_CATEGORIES } from "@/contracts";
import { PreferencesForm } from "./preferences-form";
import type { CustomerPreferences } from "./customer-preferences";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const requestJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/events/api-client", () => ({ requestJson }));

function prefs(overrides: Partial<CustomerPreferences> = {}): CustomerPreferences {
  return { interests: [], city: null, hasPreferences: false, ...overrides };
}

const save = () => screen.getByRole("button", { name: "Save preferences" });

describe("PreferencesForm", () => {
  beforeEach(() => {
    router.refresh.mockReset();
    router.push.mockReset();
    requestJson.mockReset();
    requestJson.mockResolvedValue({ ok: true, data: prefs() });
  });

  it("offers every category", () => {
    render(<PreferencesForm preferences={prefs()} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(EVENT_CATEGORIES.length);
  });

  it("makes clear that preferences are optional and non-filtering", () => {
    render(<PreferencesForm preferences={prefs()} />);
    expect(screen.getByText(/browse everything without setting them/)).toBeVisible();
  });

  it("states that no device location is used", () => {
    render(<PreferencesForm preferences={prefs()} />);
    expect(screen.getByText(/never ask for your device/)).toBeVisible();
  });

  it("saves selected interests and a typed city", async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs()} />);

    await user.click(screen.getByRole("checkbox", { name: "Live music" }));
    await user.click(screen.getByRole("checkbox", { name: "Comedy" }));
    await user.type(screen.getByLabelText("City or region"), "Dublin");
    await user.click(save());

    const [url, init] = requestJson.mock.calls[0]!;
    expect(url).toBe("/api/profiles/customers/me/preferences");
    expect(init.method).toBe("PATCH");
    expect(init.body.interests).toEqual(["MUSIC", "COMEDY"]);
    expect(init.body.city).toBe("Dublin");
  });

  it("pre-selects stored preferences", () => {
    render(<PreferencesForm preferences={prefs({ interests: ["SPORT"], city: "Cork" })} />);
    expect(screen.getByRole("checkbox", { name: "Sport" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Live music" })).not.toBeChecked();
    expect(screen.getByLabelText("City or region")).toHaveValue("Cork");
  });

  it("deselects an interest that was previously chosen", async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs({ interests: ["SPORT"], hasPreferences: true })} />);

    await user.click(screen.getByRole("checkbox", { name: "Sport" }));
    await user.click(save());

    expect(requestJson.mock.calls[0]![1].body.interests).toEqual([]);
  });

  it("saves an empty selection, which is how preferences are cleared", async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs()} />);
    await user.click(save());

    expect(requestJson.mock.calls[0]![1].body).toEqual({ interests: [], city: "" });
  });

  it("offers Clear all only when something is set", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PreferencesForm preferences={prefs()} />);
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    unmount();

    render(<PreferencesForm preferences={prefs({ interests: ["FILM"], hasPreferences: true })} />);
    expect(screen.getByRole("button", { name: "Clear all" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(requestJson.mock.calls[0]![1].body).toEqual({ interests: [], city: "" });
    expect(screen.getByRole("checkbox", { name: "Film" })).not.toBeChecked();
  });

  it("shows Skip only in the onboarding step and does not save when used", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PreferencesForm preferences={prefs()} />);
    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
    unmount();

    render(<PreferencesForm preferences={prefs()} showSkip doneHref="/" />);
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(requestJson).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("continues to the given destination after a successful save", async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs()} doneHref="/profile" />);
    await user.click(save());
    expect(router.push).toHaveBeenCalledWith("/profile");
  });

  it("surfaces a failure and stays put", async () => {
    requestJson.mockResolvedValue({
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Sign in required",
    });
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs()} doneHref="/profile" />);
    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in required");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("uses real checkboxes so the options are keyboard reachable", async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={prefs()} />);

    await user.tab();
    const first = screen.getByRole("checkbox", { name: "Live music" });
    expect(first).toHaveFocus();
    await user.keyboard(" ");
    expect(first).toBeChecked();
  });
});
