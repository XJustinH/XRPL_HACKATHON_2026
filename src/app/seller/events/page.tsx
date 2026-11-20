import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Manage events" };

export default function SellerEventsPage() {
  return (
    <>
      <PageHeader
        title="Manage events"
        description="Create event drafts, define ticket tiers, and publish when the details are final."
      />
      <NotImplementedNotice
        title="Seller event management"
        blockedBy="XRPL-015 / XRPL-016 / XRPL-017, which need the event schema from XRPL-005 and role enforcement from XRPL-013"
      />
    </>
  );
}
