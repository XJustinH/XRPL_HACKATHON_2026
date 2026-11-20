import Link from "next/link";

const XRPL_NETWORK_LABEL = process.env.NEXT_PUBLIC_XRPL_NETWORK_LABEL ?? "XRPL Testnet";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 text-sm text-muted">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Tickets are NFTs on {XRPL_NETWORK_LABEL}. Ownership is read from the
            ledger, not from this site.
          </p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-4">
              <li>
                <Link href="/" className="hover:text-ink">
                  Discover
                </Link>
              </li>
              <li>
                <Link href="/resale" className="hover:text-ink">
                  Resale
                </Link>
              </li>
              <li>
                <a
                  href="https://testnet.xrpl.org/"
                  className="hover:text-ink"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Testnet explorer
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <p className="mt-4 text-xs">
          Test network only — no real funds are involved. A transferable NFT can
          be moved outside this application, so in-app resale rules apply here
          and not on the ledger itself.
        </p>
      </div>
    </footer>
  );
}
