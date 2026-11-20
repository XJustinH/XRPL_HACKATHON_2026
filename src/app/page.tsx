import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export default function HomePage() {
  return (
    <>
      <PageHeader
        title="Discover events"
        description="Buy tickets that exist as NFTs on the XRP Ledger Testnet. Ownership and transfers are verified against the ledger."
      />
      <NotImplementedNotice
        title="Published event listings"
        blockedBy="XRPL-018 (homepage listings), which needs the event schema from XRPL-005 and publish states from XRPL-017"
      />
      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        {[
          {
            title: "Ledger-backed tickets",
            body: "Every ticket is a uniquely identifiable NFT with a stable metadata URI and a validated mint transaction.",
          },
          {
            title: "Non-custodial by design",
            body: "Purchases and transfers are approved in your own wallet. The platform never asks for a seed or private key.",
          },
          {
            title: "Verifiable entry",
            body: "Organisers check current on-chain ownership at the door, and each ticket admits once.",
          },
        ].map((card) => (
          <article
            key={card.title}
            className="rounded-card border border-border bg-surface-raised p-5"
          >
            <h2 className="text-sm font-semibold">{card.title}</h2>
            <p className="mt-2 text-sm text-muted">{card.body}</p>
          </article>
        ))}
      </section>
      <p className="mt-8 text-sm text-muted">
        Running an event?{" "}
        <Link href="/seller/events" className="font-medium text-accent underline">
          Manage your events
        </Link>
        .
      </p>
    </>
  );
}
