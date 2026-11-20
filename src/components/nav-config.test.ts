import { describe, expect, it } from "vitest";
import {
  accountNav,
  isActiveHref,
  primaryNav,
  visibleNavItems,
  type NavItem,
} from "./nav-config";

const items: NavItem[] = [
  { href: "/", label: "Public" },
  { href: "/tickets", label: "Session only", requiresSession: true },
  {
    href: "/seller/events",
    label: "Seller only",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
  },
];

describe("visibleNavItems", () => {
  it("shows only public links when there is no session", () => {
    expect(visibleNavItems(items, null).map((i) => i.label)).toEqual(["Public"]);
  });

  it("shows session links but hides seller links for a customer", () => {
    const visible = visibleNavItems(items, { role: "CUSTOMER" });
    expect(visible.map((i) => i.label)).toEqual(["Public", "Session only"]);
  });

  it("shows seller links for sellers and organisers", () => {
    for (const role of ["SELLER", "ORGANISER"] as const) {
      expect(visibleNavItems(items, { role }).map((i) => i.label)).toEqual([
        "Public",
        "Session only",
        "Seller only",
      ]);
    }
  });

  it("keeps every primary and account link reachable for an organiser", () => {
    const all = [
      ...visibleNavItems(primaryNav, { role: "ORGANISER" }),
      ...visibleNavItems(accountNav, { role: "ORGANISER" }),
    ];
    expect(all.length).toBe(primaryNav.length + accountNav.length);
  });
});

describe("isActiveHref", () => {
  it("matches the home route only exactly", () => {
    expect(isActiveHref("/", "/")).toBe(true);
    expect(isActiveHref("/", "/tickets")).toBe(false);
  });

  it("matches a section and its nested routes", () => {
    expect(isActiveHref("/tickets", "/tickets")).toBe(true);
    expect(isActiveHref("/tickets", "/tickets/abc")).toBe(true);
  });

  it("does not match a different section with a shared prefix", () => {
    expect(isActiveHref("/resale", "/resale-policy")).toBe(false);
  });
});
