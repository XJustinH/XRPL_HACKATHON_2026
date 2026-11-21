import Link from "next/link";
import type { MerchOrderDto } from "@/contracts/commerce";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listMyOrders } from "@/features/commerce/orders";
import { FULFILMENT_TEXT, OrderCard } from "@/features/commerce/order-summary";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Your orders" };

/**
 * XRPL-069: a customer's merchandise order history, newest first.
 *
 * Lists only orders the signed-in account placed. Orders a seller received are on
 * `/seller/products`.
 */
export default async function OrdersPage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Your orders" />
        <EmptyState
          title="Sign in to see your orders"
          description="Your merchandise orders and their delivery status are listed here."
          action={
            <Link
              href="/onboarding"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Get started
            </Link>
          }
        />
      </>
    );
  }

  let orders: MerchOrderDto[] | null = null;
  try {
    orders = await listMyOrders(getDb(), session);
  } catch (error) {
    console.error("[commerce] could not load order history", error);
  }

  return (
    <>
      <PageHeader
        title="Your orders"
        description="Merchandise you have ordered. Payment is simulated in this build, so no money has moved for any of them."
      />
      {orders === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your orders could not be loaded. Refresh to try again.
        </p>
      ) : orders.length === 0 ? (
        <EmptyState
          title="You have not ordered anything yet"
          description="Merchandise you order from a seller's page will appear here with its status."
          action={
            <Link
              href="/"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Browse events and sellers
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} counterparty={`From ${order.sellerName}`}>
              <p className="text-sm text-muted">{FULFILMENT_TEXT[order.status]}</p>
            </OrderCard>
          ))}
        </ul>
      )}
    </>
  );
}
