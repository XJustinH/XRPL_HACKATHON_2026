import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "My tickets" };

export default function MyTicketsPage() {
  return (
    <>
      <PageHeader
        title="My tickets"
        description="Tickets currently owned by your connected wallet, as reconciled from the XRP Ledger."
      />
      <NotImplementedNotice
        title="Wallet ticket collection"
        blockedBy="XRPL-033, which needs wallet connect from XRPL-011 and ownership reads from XRPL-026 / XRPL-028"
      />
    </>
  );
}
