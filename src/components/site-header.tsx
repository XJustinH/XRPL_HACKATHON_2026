"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { UserRole } from "@/contracts";
import {
  accountNav,
  isActiveHref,
  primaryNav,
  visibleNavItems,
} from "@/components/nav-config";

export type HeaderSession = {
  displayName: string;
  role: UserRole;
  walletAddress: string | null;
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
  const account = visibleNavItems(accountNav, session);

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
          <span className="hidden sm:inline">XRPL Tickets</span>
        </Link>

        <nav aria-label="Primary" className="ml-2 hidden flex-1 md:block">
          <ul className="flex items-center gap-1">
            {items.map((item) => {
              const active = isActiveHref(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
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
            <Link
              href="/profile"
              className="hidden items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface sm:flex"
            >
              <span className="font-medium">{session.displayName}</span>
              {session.walletAddress ? (
                <span className="font-mono text-xs text-muted">
                  {truncateAddress(session.walletAddress)}
                </span>
              ) : null}
            </Link>
          ) : (
            <Link
              href="/connect"
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Connect wallet
            </Link>
          )}

          <button
            ref={toggleRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            className="grid size-10 place-items-center rounded-lg border border-border md:hidden"
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
        <div id={menuId} className="border-t border-border bg-canvas md:hidden">
          <nav aria-label="Mobile" className="mx-auto w-full max-w-6xl px-4 py-3">
            <ul className="flex flex-col gap-1">
              {[...items, ...account].map((item) => {
                const active = isActiveHref(item.href, pathname);
                return (
                  <li key={item.href}>
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
          </nav>
        </div>
      ) : null}
    </header>
  );
}
