import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";

export const metadata = { title: "Wishlist" };

export default function WishlistPage() {
  return (
    <>
      <PageHeader
        title="Wishlist"
        description="Events you have saved. Sharing your wishlist with friends is off unless you turn it on."
      />
      <NotImplementedNotice
        title="Event wishlist"
        blockedBy="XRPL-062, which needs the customer profile from XRPL-056"
      />
    </>
  );
}
