import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoPersonaList } from "./demo-persona-list";
import { OnboardingForm } from "./onboarding-form";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("OnboardingForm", () => {
  it("offers customer and seller only, with customer preselected", () => {
    render(<OnboardingForm />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /here for events/ })).toBeChecked();
    expect(screen.queryByText(/organiser/i)).not.toBeInTheDocument();
  });

  it("validates the display name before calling the API", async () => {
    const user = userEvent.setup();
    render(<OnboardingForm />);
    await user.type(screen.getByLabelText("Display name"), "A");
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 2 characters");
    expect(screen.getByLabelText("Display name")).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits the chosen role and sends sellers to their events", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json(201, { data: { user: { role: "SELLER" } } }));
    render(<OnboardingForm />);

    await user.click(screen.getByRole("radio", { name: /I run events/ }));
    await user.type(screen.getByLabelText("Display name"), "Vicar St Live");
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/onboarding");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ displayName: "Vicar St Live", role: "SELLER" });
    expect(router.push).toHaveBeenCalledWith("/seller/events");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the server's message and lets the user retry", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      json(409, { error: { code: "ALREADY_ONBOARDED", message: "This account has already chosen a role." }, requestId: "r" }),
    );
    render(<OnboardingForm />);
    await user.type(screen.getByLabelText("Display name"), "Aoife");
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already chosen a role");
    expect(screen.getByRole("button", { name: "Create profile" })).toBeEnabled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("reports network failures without navigating", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<OnboardingForm />);
    await user.type(screen.getByLabelText("Display name"), "Aoife");
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("disables submission while saving", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<OnboardingForm />);
    await user.type(screen.getByLabelText("Display name"), "Aoife");
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });
});

describe("DemoPersonaList", () => {
  const personas = [
    { userId: "6f1c1f3e-2b8a-4d6c-9a51-1f8f0d2b7c11", displayName: "Demo Venue", role: "SELLER" as const },
    { userId: "7a2d2e4f-3c9b-4e7d-8b62-2a9a1e3c8d22", displayName: "Demo Fan", role: "CUSTOMER" as const },
  ];

  it("explains when no demo accounts exist yet", () => {
    render(<DemoPersonaList personas={[]} />);
    expect(screen.getByText(/No demo accounts have been added yet/)).toBeInTheDocument();
  });

  it("switches into a persona and lands on that role's home", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json(200, { data: { user: {} } }));
    render(<DemoPersonaList personas={personas} />);

    await user.click(screen.getByRole("button", { name: "Continue as Demo Venue" }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/demo-session");
    expect(JSON.parse(init.body)).toEqual({ userId: personas[0]!.userId });
    expect(router.push).toHaveBeenCalledWith("/seller/events");
  });

  it("marks the persona already in use", () => {
    render(<DemoPersonaList personas={personas} currentUserId={personas[1]!.userId} />);
    expect(screen.getByRole("button", { name: "Signed in" })).toBeDisabled();
  });
});
