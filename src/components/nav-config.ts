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
  {
    href: "/seller/profile",
    label: "Your storefront",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
  },
  { href: "/following", label: "Following", requiresSession: true },
  // Community (XRPL-080 to XRPL-083, XRPL-093). /moderation is also open to site moderators by URL.
  { href: "/notifications", label: "Notifications", requiresSession: true },
  { href: "/seller/posts", label: "Posts", roles: ["SELLER", "ORGANISER"], requiresSession: true },
  { href: "/moderation", label: "Moderation", roles: ["SELLER", "ORGANISER"], requiresSession: true },
  // Physical merchandise (XRPL-065 to XRPL-069).
  { href: "/cart", label: "Cart", requiresSession: true },
  { href: "/orders", label: "Orders", requiresSession: true },
  {
    href: "/seller/products",
    label: "Merchandise",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
  },
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
