import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <>
      <PageHeader
        title="Your profile"
        description="Your display name, chosen city and interests. Profile visibility is yours to control."
      />
      <NotImplementedNotice
        title="Customer profile and activity"
        blockedBy="XRPL-056, which needs onboarding from XRPL-010"
      />
    </>
  );
}
