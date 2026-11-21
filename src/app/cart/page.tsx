import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { CartView } from "@/features/commerce/cart-view";
import { getCurrentSession } from "@/lib/auth/current-session";

export const metadata = { title: "Cart" };

/**
 * XRPL-067: the merchandise cart and checkout.
 *
 * The cart is kept in the visitor's browser, so anyone can fill it; placing the order needs an
 * account. Payment is simulated and the page says so: no card details are asked for or stored.
 */
export default async function CartPage() {
  const session = await getCurrentSession();
  return (
    <>
      <PageHeader
        title="Your cart"
        description="Physical merchandise only. Tickets and digital collectibles are bought on their own pages."
        actions={
          session ? (
            <Link href="/orders" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface">
              Your orders
            </Link>
          ) : undefined
        }
      />
      <CartView signedIn={!!session} defaultName={session?.displayName ?? ""} />
    </>
  );
}
