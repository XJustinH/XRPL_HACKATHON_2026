"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { UserRole } from "@/contracts";
import { isActiveHref, menuGroups, primaryNav, visibleNavItems } from "@/components/nav-config";
import { SignOutButton } from "@/features/onboarding/sign-out-button";

export type HeaderSession = {
  displayName: string;
  role: UserRole;
  walletAddress: string | null;
};

const ROLE_NAME: Record<UserRole, string> = {
  CUSTOMER: "Customer",
  SELLER: "Seller",
  ORGANISER: "Organiser",
};

/** Shortens an XRPL address for display without hiding its identity entirely. */
function truncateAddress(address: string): string {
  return address.length <= 14
    ? address
    : `${address.slice(0, 7)}…${address.slice(-5)}`;
}

export function SiteHeader({ session }: { session: HeaderSession | null }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renderedPath, setRenderedPath] = useState(pathname);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  /*
   * Navigating must never leave the drawer open behind the new page. Adjusting
   * during render (rather than in an effect) also covers browser back/forward,
   * which does not go through the link handlers.
   */
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const items = visibleNavItems(primaryNav, session);
  const groups = menuGroups(session);
  /*
   * Account links live only in the menu, so the menu must be reachable at every width once
   * there are any. Without them, wide screens need no menu: the primary links are in the bar.
   * The bar is 72rem at most, so it only holds the primary links from `lg` up, and the account
   * box beside them from `xl`: below that they would run into each other.
   */
  const menuOnWideScreens = groups.some((group) => !group.primary);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 text-base font-semibold tracking-tight"
        >
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-ink"
          >
            XT
          </span>
          {/* Hidden from sight on phones, never from screen readers: it is the link's only name. */}
          <span className="sr-only sm:not-sr-only">XRPL Tickets</span>
        </Link>

        <nav aria-label="Primary" className="ml-2 hidden min-w-0 flex-1 lg:block">
          <ul className="flex items-center gap-1">
            {items.map((item) => {
              const active = isActiveHref(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "bg-accent-soft text-accent"
                        : "text-muted hover:bg-surface hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {session ? (
            <>
              {/* Who is signed in, as what, and with which wallet: always in sight on wider screens. */}
              <Link
                href="/profile"
                className="hidden items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface sm:flex lg:hidden xl:flex"
              >
                <span className="max-w-28 truncate font-medium">{session.displayName}</span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                  {ROLE_NAME[session.role]}
                </span>
                {session.walletAddress ? (
                  <span className="font-mono text-xs text-muted">
                    {truncateAddress(session.walletAddress)}
                  </span>
                ) : null}
              </Link>
              {session.walletAddress ? null : (
                <Link
                  href="/connect"
                  className="whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
                >
                  Connect wallet
                </Link>
              )}
            </>
          ) : (
            <>
              <Link
                href="/onboarding"
                className="whitespace-nowrap rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-surface"
              >
                Sign in
              </Link>
              <Link
                href="/connect"
                className="whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Connect wallet
              </Link>
            </>
          )}

          <button
            ref={toggleRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            className={`grid size-11 shrink-0 place-items-center rounded-lg border border-border ${
              menuOnWideScreens ? "" : "lg:hidden"
            }`}
          >
            <span className="sr-only">
              {menuOpen ? "Close main menu" : "Open main menu"}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              {menuOpen ? (
                <path d="M6 6l12 12M18 6L6 18" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div
          id={menuId}
          className={`max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-border bg-canvas ${
            menuOnWideScreens ? "" : "lg:hidden"
          }`}
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-4">
            {session ? (
              <div className="mb-4 rounded-lg border border-border bg-surface px-3 py-3 text-sm">
                <p>
                  Signed in as <span className="font-semibold">{session.displayName}</span>
                  <span className="text-muted"> · {ROLE_NAME[session.role]}</span>
                </p>
                <p className="mt-1 text-muted">
                  {session.walletAddress ? (
                    <>
                      Wallet <span className="font-mono text-xs">{truncateAddress(session.walletAddress)}</span>
                    </>
                  ) : (
                    "No wallet connected yet. You need one to buy, sell or check in."
                  )}
                </p>
              </div>
            ) : null}

            <nav aria-label="Menu">
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 md:grid-cols-3">
                {groups.map((group) => {
                  const headingId = `${menuId}-${group.name.replace(/\s+/g, "-").toLowerCase()}`;
                  return (
                    // Primary links are already in the bar on wide screens.
                    <section
                      key={group.name}
                      aria-labelledby={headingId}
                      className={group.primary ? "lg:hidden" : undefined}
                    >
                      <h2 id={headingId} className="px-3 text-xs font-semibold uppercase tracking-wide text-muted">
                        {group.name}
                      </h2>
                      <ul className="mt-1 flex flex-col gap-1">
                        {group.items.map((item) => {
                          const active = isActiveHref(item.href, pathname);
                          return (
                            <li key={item.href} className={group.primary ? "lg:hidden" : undefined}>
                              <Link
                                href={item.href}
                                aria-current={active ? "page" : undefined}
                                className={`block rounded-lg px-3 py-3 text-base font-medium ${
                                  active ? "bg-accent-soft text-accent" : "hover:bg-surface"
                                }`}
                              >
                                {item.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </nav>

            {session ? (
              <div className="mt-4 flex flex-wrap items-start gap-3 border-t border-border pt-4">
                <Link
                  href="/onboarding"
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
                >
                  Switch account
                </Link>
                <SignOutButton />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
