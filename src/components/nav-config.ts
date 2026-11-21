import type { UserRole } from "@/contracts";

export type NavItem = {
  href: string;
  label: string;
  /** Roles permitted to see the link. Omitted means visible to everyone. */
  roles?: UserRole[];
  /** Hidden until a session exists. */
  requiresSession?: boolean;
  /** Heading the link sits under in the menu. Primary links are listed under "Browse". */
  group?: MenuGroupName;
};

/** Menu headings, in the order they are shown. */
export const MENU_GROUPS = ["Browse", "Your things", "Selling", "Account"] as const;
export type MenuGroupName = (typeof MENU_GROUPS)[number];

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
  // Digital collectibles (XRPL-072 to XRPL-075): browse them, and see the ones your wallet holds.
  { href: "/collectibles", label: "Collectibles" },
  {
    href: "/seller/events",
    label: "Manage events",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
  },
];

export const accountNav: NavItem[] = [
  { href: "/profile", label: "Profile", requiresSession: true, group: "Account" },
  {
    href: "/seller/profile",
    label: "Your storefront",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // The door: check-in scanner, inventory and entry analytics for each event (XRPL-046 to XRPL-049).
  {
    href: "/organiser/events",
    label: "Door and check-in",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // Storefront analytics (XRPL-078): tickets, merchandise orders and collectible sales, kept apart.
  {
    href: "/seller/analytics",
    label: "Analytics",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // Kept out of the bar, which has room for the main destinations only.
  { href: "/wishlist", label: "Wishlist", requiresSession: true, group: "Your things" },
  { href: "/following", label: "Following", requiresSession: true, group: "Your things" },
  { href: "/friends", label: "Friends", requiresSession: true, group: "Your things" },
  // Community (XRPL-080 to XRPL-083, XRPL-093). /moderation is also open to site moderators by URL.
  { href: "/notifications", label: "Notifications", requiresSession: true, group: "Account" },
  {
    href: "/seller/posts",
    label: "Posts",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  {
    href: "/moderation",
    label: "Moderation",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // Physical merchandise (XRPL-065 to XRPL-069).
  { href: "/cart", label: "Cart", requiresSession: true, group: "Your things" },
  { href: "/orders", label: "Orders", requiresSession: true, group: "Your things" },
  {
    href: "/seller/products",
    label: "Merchandise",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // Digital collectibles (XRPL-070 to XRPL-074): upload media, publish, mint and list editions.
  {
    href: "/seller/collectibles",
    label: "Sell collectibles",
    roles: ["SELLER", "ORGANISER"],
    requiresSession: true,
    group: "Selling",
  },
  // The wallet page shows which wallet is linked and connects or disconnects it.
  { href: "/connect", label: "Wallet", requiresSession: true, group: "Account" },
  { href: "/preferences", label: "Preferences", requiresSession: true, group: "Account" },
  { href: "/privacy", label: "Privacy", requiresSession: true, group: "Account" },
];

export type MenuGroup = { name: MenuGroupName; items: NavItem[]; primary: boolean };

/**
 * The menu's links under their headings, for this session. Primary links form "Browse", which the
 * bar already shows on wide screens; a group with nothing visible is left out.
 */
export function menuGroups(session: { role: UserRole } | null): MenuGroup[] {
  const account = visibleNavItems(accountNav, session);
  return MENU_GROUPS.map((name) => ({
    name,
    primary: name === "Browse",
    items: name === "Browse" ? visibleNavItems(primaryNav, session) : account.filter((item) => item.group === name),
  })).filter((group) => group.items.length > 0);
}

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
