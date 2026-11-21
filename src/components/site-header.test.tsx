import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SiteHeader } from "./site-header";

const pathname = vi.hoisted(() => ({ current: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

describe("SiteHeader", () => {
  beforeEach(() => {
    pathname.current = "/";
  });

  it("prompts to connect a wallet when unauthenticated", () => {
    render(<SiteHeader session={null} />);
    expect(screen.getByRole("link", { name: "Connect wallet" })).toBeVisible();
  });

  it("marks the current route for assistive technology", () => {
    pathname.current = "/resale";
    render(<SiteHeader session={null} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Resale" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Discover" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("exposes the signed-in display name and truncated address", () => {
    render(
      <SiteHeader
        session={{
          displayName: "Aoife",
          role: "CUSTOMER",
          walletAddress: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /Aoife/ });
    expect(link).toHaveAttribute("href", "/profile");
    expect(link).toHaveTextContent("rPT1Sjq…bpAYe");
  });

  it("toggles the mobile menu and reports its expanded state", async () => {
    const user = userEvent.setup();
    render(<SiteHeader session={null} />);

    const toggle = screen.getByRole("button", { name: "Open main menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("navigation", { name: "Menu" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Close main menu" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeVisible();
  });

  it("closes the mobile menu on Escape and restores focus to the toggle", async () => {
    const user = userEvent.setup();
    render(<SiteHeader session={null} />);

    await user.click(screen.getByRole("button", { name: "Open main menu" }));
    await user.keyboard("{Escape}");

    const toggle = screen.getByRole("button", { name: "Open main menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("keeps the menu reachable on wide screens once there are account links", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SiteHeader session={null} />);
    // Signed out there are no account links, so wide screens need no menu button.
    expect(screen.getByRole("button", { name: "Open main menu" })).toHaveClass("md:hidden");
    unmount();

    render(<SiteHeader session={{ displayName: "Band", role: "SELLER", walletAddress: null }} />);
    const toggle = screen.getByRole("button", { name: "Open main menu" });
    expect(toggle).not.toHaveClass("md:hidden");
    await user.click(toggle);

    // Account links exist only in the menu. Primary links are in the bar on wide screens.
    const menu = screen.getByRole("navigation", { name: "Menu" });
    expect(within(menu).getByRole("link", { name: "Following" }).closest("li")).not.toHaveClass("md:hidden");
    expect(within(menu).getByRole("link", { name: "Your storefront" })).toBeVisible();
    expect(within(menu).getByRole("link", { name: "Discover" }).closest("li")).toHaveClass("md:hidden");
  });

  it("hides seller navigation from customers", () => {
    render(
      <SiteHeader
        session={{ displayName: "Aoife", role: "CUSTOMER", walletAddress: null }}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "Manage events" }),
    ).not.toBeInTheDocument();
  });
});
