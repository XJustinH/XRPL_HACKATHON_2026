import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Resale" };

export default function ResalePage() {
  return (
    <>
      <PageHeader
        title="Resale tickets"
        description="Tickets listed for resale by their current owners. Listings appear here only once an event's primary tickets have sold out."
      />
      <NotImplementedNotice
        title="Public resale marketplace"
        blockedBy="XRPL-038, which needs the in-app eligibility policy from XRPL-037 and live offers from XRPL-036"
      />
    </>
  );
}
