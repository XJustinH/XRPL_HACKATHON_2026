import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { getCurrentSession, toHeaderSession } from "@/lib/auth/current-session";

export const metadata: Metadata = {
  title: {
    default: "XRPL Tickets — NFT ticketing on the XRP Ledger",
    template: "%s · XRPL Tickets",
  },
  description:
    "Discover events, buy NFT tickets on the XRP Ledger Testnet, and verify ticket ownership against the ledger.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // User scaling is left enabled deliberately; never set maximumScale here.
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  /*
   * Server-side session from XRPL-010. Reading the session cookie makes every
   * route dynamic. Navigation visibility stays presentation only: route handlers
   * enforce access themselves.
   */
  const session = await getCurrentSession();
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-ink"
        >
          Skip to main content
        </a>
        <SiteHeader session={session ? toHeaderSession(session) : null} />
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
