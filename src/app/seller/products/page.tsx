import Link from "next/link";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import { CANCEL_RESTOCK_NOTICE, type MerchOrderDto, type PhysicalProductDto } from "@/contracts/commerce";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listSellerOrders } from "@/features/commerce/orders";
import { OrderStatusControls } from "@/features/commerce/order-status-controls";
import { OrderCard, OrderItems } from "@/features/commerce/order-summary";
import { ProductManager } from "@/features/commerce/product-manager";
import { listSellerProducts } from "@/features/commerce/products";
import { commerceDeps } from "@/features/commerce/server";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Merchandise" };

/**
 * XRPL-065 and XRPL-068: a seller manages their physical merchandise and the orders for it.
 *
 * Reads only the signed-in account's own products and orders. Every change goes through an API
 * route that checks ownership again on the server, so hiding this page is not what protects them.
 */
export default async function SellerProductsPage() {
  const session = await getCurrentSession();
  const canManage =
    !!session && !!session.onboardedAt && (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canManage) {
    return (
      <>
        <PageHeader title="Merchandise" />
        <EmptyState
          title={session ? "Your account can't sell merchandise" : "Sign in to manage merchandise"}
          description="Merchandise is sold by seller and organiser accounts."
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

  let products: PhysicalProductDto[] = [];
  let orders: MerchOrderDto[] = [];
  let loadFailed = false;
  try {
    const db = getDb();
    [products, orders] = await Promise.all([
      listSellerProducts(commerceDeps(db), session.userId, session),
      listSellerOrders(db, session),
    ]);
  } catch (error) {
    console.error("[commerce] could not load seller merchandise", error);
    loadFailed = true;
  }

  return (
    <>
      <PageHeader
        title="Merchandise"
        description="Physical products you sell, and the orders customers have placed for them. Published products appear on your public storefront."
        actions={
          <Link
            href={`/sellers/${session.userId}`}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface"
          >
            View storefront
          </Link>
        }
      />

      {loadFailed ? (
        <p role="alert" className="mb-6 rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your merchandise could not be loaded. Refresh to try again.
        </p>
      ) : null}

      <ProductManager products={products} />

      <section aria-labelledby="incoming-orders" className="mt-10">
        <h2 id="incoming-orders" className="text-lg font-semibold">
          Incoming orders
        </h2>
        <p className="mb-3 mt-1 max-w-2xl text-sm text-muted">
          Stock was taken when each order was placed. {CANCEL_RESTOCK_NOTICE} Payment is simulated, so no money has
          moved.
        </p>
        {orders.length === 0 ? (
          <EmptyState title="No orders yet" description="Orders for your published products will appear here." />
        ) : (
          <ul className="flex flex-col gap-3">
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} counterparty={`For ${order.buyerName}`}>
                <OrderItems order={order} />
                <p className="mt-3 text-sm">
                  <span className="font-medium">Deliver to:</span> {order.shippingName},{" "}
                  <span className="whitespace-pre-line text-muted">{order.shippingAddress}</span>
                </p>
                <div className="mt-4">
                  <OrderStatusControls orderId={order.id} status={order.status} />
                </div>
              </OrderCard>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
