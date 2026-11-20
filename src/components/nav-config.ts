import type { UserRole } from "@/contracts";

export type NavItem = {
  href: string;
  label: string;
  /** Roles permitted to see the link. Omitted means visible to everyone. */
  roles?: UserRole[];
  /** Hidden until a session exists. */
  requiresSession?: boolean;
};

/**
 * Primary navigation.
 *
 * Visibility here is presentation only — every route and route handler performs
 * its own server-side session and role check. Hiding a link is never treated as
 * authorisation.
 */
export const primaryNav: NavItem[] = [
  { href: "/", label: "Discover" },
  { href: "/search", label: "Search" },
  { href: "/resale", label: "Resale" },
  { href: "/tickets", label: "My tickets", requiresSession: true },
  { href: "/wishlist", label: "Wishlist", requiresSession: true },
  {
    href: "/seller/events",
    label: "Manage events",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
  },
];

export const accountNav: NavItem[] = [
  { href: "/profile", label: "Profile", requiresSession: true },
  { href: "/following", label: "Following", requiresSession: true },
];

export function visibleNavItems(
  items: NavItem[],
  session: { role: UserRole } | null,
): NavItem[] {
  return items.filter((item) => {
    if (item.requiresSession && !session) return false;
    if (item.roles && (!session || !item.roles.includes(session.role))) return false;
    return true;
  });
}

/** True when `href` is the active route for `pathname`. */
export function isActiveHref(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
