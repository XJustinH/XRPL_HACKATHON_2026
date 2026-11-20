import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <>
      <PageHeader
        title="Search events"
        description="Find events by name, city, date and ticket price."
      />
      <NotImplementedNotice
        title="Search and filters"
        blockedBy="XRPL-059, which builds on the homepage listings in XRPL-018"
      />
    </>
  );
}
