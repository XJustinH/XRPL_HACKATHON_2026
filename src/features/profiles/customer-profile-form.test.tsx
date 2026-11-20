import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Avatar, CustomerProfileForm } from "./customer-profile-form";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const profile = { displayName: "Aoife", imageUrl: null };

describe("CustomerProfileForm (XRPL-056)", () => {
  it("saves a new name and avatar link and refreshes the page", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json(200, { data: { displayName: "Aoife M", imageUrl: "https://img.example/a.png" } }));
    render(<CustomerProfileForm profile={profile} />);

    const name = screen.getByLabelText("Display name");
    await user.clear(name);
    await user.type(name, "Aoife M");
    await user.type(screen.getByLabelText("Avatar image link (optional)"), "https://img.example/a.png");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/profiles/customers/me");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ displayName: "Aoife M", imageUrl: "https://img.example/a.png" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("validates before calling the API", async () => {
    const user = userEvent.setup();
    render(<CustomerProfileForm profile={profile} />);
    const name = screen.getByLabelText("Display name");
    await user.clear(name);
    await user.type(name, "A");
    await user.type(screen.getByLabelText("Avatar image link (optional)"), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(screen.getByText("Use 2 to 80 characters")).toBeInTheDocument();
    expect(screen.getByText(/full https:\/\/ link/)).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty avatar link removes the avatar", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json(200, { data: { displayName: "Aoife", imageUrl: null } }));
    render(<CustomerProfileForm profile={{ displayName: "Aoife", imageUrl: "https://img.example/a.png" }} />);
    await user.clear(screen.getByLabelText("Avatar image link (optional)"));
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ displayName: "Aoife", imageUrl: "" });
  });

  it("shows the server's message when saving fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in required" }, requestId: "r" }));
    render(<CustomerProfileForm profile={profile} />);
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in required");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("Avatar", () => {
  it("shows the image for a safe link and the initial otherwise", () => {
    const { container, unmount } = render(<Avatar url="https://img.example/a.png" name="Aoife" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://img.example/a.png");
    unmount();
    render(<Avatar url="javascript:alert(1)" name="aoife" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
