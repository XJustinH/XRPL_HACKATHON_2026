import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { WalletConnectPanel } from "@/features/wallet/wallet-connect-panel";
import { getCurrentSession } from "@/lib/auth/current-session";
import { ROLE_LABEL } from "@/features/onboarding/roles";
import { loadXrplConfig } from "@/lib/xrpl";
import { testTransactionsEnabled } from "@/lib/xrpl/wallet/test-transactions";

export const metadata = { title: "Connect wallet" };

function appNetwork(): string {
  try {
    return loadXrplConfig().network;
  } catch {
    return "TESTNET";
  }
}

export default async function ConnectPage() {
  // The server decides whether a wallet is connected: only a server-verified proof counts (XRPL-012).
  const session = await getCurrentSession();
  const verifiedWallet =
    session?.walletAddress && session.walletVerifiedAt
      ? {
          address: session.walletAddress,
          network: appNetwork(),
          connectedAt: session.walletVerifiedAt.toISOString(),
        }
      : null;

  return (
    <>
      <PageHeader
        title="Connect your wallet"
        description="You approve every transaction in your own wallet. This platform never asks for a seed phrase or private key."
      />
      {/* Which account the wallet will belong to: a wallet stays with the first account that connects it. */}
      <section
        aria-labelledby="connect-account-heading"
        className="mb-6 rounded-card border border-border bg-surface p-5 text-sm"
      >
        <h2 id="connect-account-heading" className="text-sm font-semibold">
          {session ? "Your account" : "You're not signed in"}
        </h2>
        {session ? (
          <>
            <p className="mt-1">
              Signed in as <span className="font-semibold">{session.displayName}</span>
              <span className="text-muted"> · {ROLE_LABEL[session.role]}</span>
            </p>
            <p className="mt-2 text-muted">
              {verifiedWallet
                ? "The wallet below is linked to this account. Use the same account in Xaman for everything you approve here."
                : "The wallet you approve with becomes this account's wallet, and it can't be linked to a second account. If Xaman holds several accounts, check which one is shown before you approve."}{" "}
              <Link href="/onboarding" className="font-medium text-accent underline">
                Switch account
              </Link>
            </p>
          </>
        ) : (
          <p className="mt-1 text-muted">
            Connecting signs you in as the account that already owns the wallet, or starts a new account for
            it. To use a demo account with this wallet,{" "}
            <Link href="/onboarding" className="font-medium text-accent underline">
              choose the account first
            </Link>
            , then come back and connect.
          </p>
        )}
      </section>
      <WalletConnectPanel verifiedWallet={verifiedWallet} testTransactions={testTransactionsEnabled()} />
      {session ? null : (
        <section className="mt-6 flex flex-col gap-3 rounded-card border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">No wallet yet?</h2>
            <p className="mt-1 text-sm text-muted">
              Create a customer or seller profile, or use a demo account, to explore the app now.
            </p>
          </div>
          <Link
            href="/onboarding"
            className="shrink-0 rounded-lg bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Get started
          </Link>
        </section>
      )}
      <section className="mt-6 rounded-card border border-border bg-surface-raised p-5 text-sm text-muted">
        <h2 className="text-sm font-semibold text-ink">What to expect</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5">
          <li>You receive a sign request in your wallet application.</li>
          <li>You review the exact transaction and approve or reject it.</li>
          <li>
            The platform waits for the transaction to be validated on the ledger
            before showing it as confirmed.
          </li>
        </ol>
      </section>
    </>
  );
}
