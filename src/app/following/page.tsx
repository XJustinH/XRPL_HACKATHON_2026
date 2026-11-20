import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Following" };

export default function FollowingPage() {
  return (
    <>
      <PageHeader
        title="Following"
        description="Organisers and artists you follow, used to surface their new events."
      />
      <NotImplementedNotice
        title="Follow and unfollow sellers"
        blockedBy="XRPL-061, which needs seller profiles from XRPL-055"
      />
    </>
  );
}
