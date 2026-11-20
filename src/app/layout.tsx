import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XRPL Tickets",
  description: "NFT ticketing on the XRP Ledger Testnet",
};

// Minimal root layout. The responsive app shell and navigation are XRPL-003 (Agent C).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
