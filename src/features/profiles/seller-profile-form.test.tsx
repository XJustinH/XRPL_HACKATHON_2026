import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SellerProfile } from "@/contracts";
import { SellerProfileForm, cleanSocialLinks } from "./seller-profile-form";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const requestJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/events/api-client", () => ({ requestJson }));

function profile(overrides: Partial<SellerProfile> = {}): SellerProfile {
  return {
    id: "usr-1",
    displayName: "Night Market",
    bio: "We put on shows.",
    city: "Dublin",
    websiteUrl: null,
    imageUrl: null,
    socialLinks: [],
    isVerified: false,
    followerCount: null,
    publishedEventCount: 3,
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const save = () => screen.getByRole("button", { name: "Save profile" });

describe("cleanSocialLinks", () => {
  it("drops rows that are entirely empty", () => {
    expect(
      cleanSocialLinks([
        { label: "", url: "" },
        { label: "Site", url: "https://example.com" },
      ]),
    ).toEqual([{ label: "Site", url: "https://example.com" }]);
  });

  it("keeps a half-filled row so it can be reported as incomplete", () => {
    expect(cleanSocialLinks([{ label: "Site", url: "" }])).toHaveLength(1);
  });
});

describe("SellerProfileForm", () => {
  beforeEach(() => {
    router.refresh.mockReset();
    requestJson.mockReset();
    requestJson.mockResolvedValue({ ok: true, data: profile() });
  });

  it("pre-fills the current profile", () => {
    render(<SellerProfileForm profile={profile({ websiteUrl: "https://example.com" })} />);
    expect(screen.getByLabelText("Display name")).toHaveValue("Night Market");
    expect(screen.getByLabelText("Biography")).toHaveValue("We put on shows.");
    expect(screen.getByLabelText("City")).toHaveValue("Dublin");
    expect(screen.getByLabelText("Website")).toHaveValue("https://example.com");
  });

  it("saves to the self-scoped endpoint, which cannot name another account", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.clear(screen.getByLabelText("Biography"));
    await user.type(screen.getByLabelText("Biography"), "Independent promoter.");
    await user.click(save());

    expect(requestJson).toHaveBeenCalledTimes(1);
    const [url, init] = requestJson.mock.calls[0]!;
    expect(url).toBe("/api/profiles/sellers/me");
    expect(init.method).toBe("PATCH");
    expect(init.body).toMatchObject({ bio: "Independent promoter." });
    // No id travels with the request at all.
    expect(init.body).not.toHaveProperty("id");
    expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
  });

  it("rejects a website that is not a URL", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.type(screen.getByLabelText("Website"), "example.com");
    await user.click(save());

    expect(requestJson).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Website")).toHaveAttribute("aria-invalid", "true");
  });

  it("rejects a display name that is too short", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "X");
    await user.click(save());

    expect(requestJson).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Display name")).toHaveAttribute("aria-invalid", "true");
  });

  it("ignores a blank link row instead of complaining about it", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    // The form starts with one empty row; submitting must still succeed.
    await user.click(save());

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]![1].body.socialLinks).toEqual([]);
  });

  it("reports a link that has a label but no URL", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.type(screen.getByLabelText("Link 1 label"), "Instagram");
    await user.click(save());

    expect(requestJson).not.toHaveBeenCalled();
    expect(screen.getByText(/both a label and a URL/)).toBeVisible();
  });

  it("sends a completed link", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.type(screen.getByLabelText("Link 1 label"), "Instagram");
    await user.type(screen.getByLabelText("Link 1 URL"), "https://instagram.com/nm");
    await user.click(save());

    expect(requestJson.mock.calls[0]![1].body.socialLinks).toEqual([
      { label: "Instagram", url: "https://instagram.com/nm" },
    ]);
  });

  it("adds and removes link rows", async () => {
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.click(screen.getByRole("button", { name: "Add a link" }));
    expect(screen.getByLabelText("Link 2 label")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove link 2" }));
    expect(screen.queryByLabelText("Link 2 label")).not.toBeInTheDocument();
  });

  it("stops offering more rows at the limit of six", async () => {
    const user = userEvent.setup();
    render(
      <SellerProfileForm
        profile={profile({
          socialLinks: Array.from({ length: 6 }, (_, i) => ({
            label: `L${i}`,
            url: `https://example.com/${i}`,
          })),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add a link" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove link 6" }));
    expect(screen.getByRole("button", { name: "Add a link" })).toBeVisible();
  });

  it("surfaces a server refusal and keeps the edits", async () => {
    requestJson.mockResolvedValue({
      ok: false,
      code: "ROLE_REQUIRED",
      message: "Your account type can't do this.",
    });
    const user = userEvent.setup();
    render(<SellerProfileForm profile={profile()} />);

    await user.clear(screen.getByLabelText("City"));
    await user.type(screen.getByLabelText("City"), "Cork");
    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent("Your account type can't do this.");
    expect(screen.getByLabelText("City")).toHaveValue("Cork");
  });
});
