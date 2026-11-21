import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { PHYSICAL_MERCH_LABEL, SIMULATED_PAYMENT_NOTICE, type MerchOrderDto } from "@/contracts/commerce";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getOrder } from "@/features/commerce/orders";
import { OrderStatusControls } from "@/features/commerce/order-status-controls";
import { FULFILMENT_TEXT, OrderItems, OrderStatusBadge, formatOrderDate } from "@/features/commerce/order-summary";
import { card, notice } from "@/features/wallet/styles";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";

export const metadata = { title: "Order" };

/**
 * XRPL-069: one merchandise order with its items, total and fulfilment state.
 *
 * Only the purchaser and the order's seller can open it. Anyone else, signed in or not, gets the
 * same "not found" page as for an order that doesn't exist. The seller also gets the status
 * buttons (XRPL-068).
 */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const session = await getCurrentSession();
  if (!session) notFound();

  let order: MerchOrderDto;
  try {
    order = await getOrder(getDb(), session, id.data);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  const isSeller = order.sellerId === session.userId;
  const isBuyer = order.buyerId === session.userId;

  return (
    <>
      <PageHeader
        title={`Order ${order.id.slice(0, 8)}`}
        description={`Placed ${formatOrderDate(order.createdAt)} · ${
          isBuyer ? `sold by ${order.sellerName}` : `ordered by ${order.buyerName}`
        }`}
        actions={
          <Link
            href={isBuyer ? "/orders" : "/seller/products"}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface"
          >
            {isBuyer ? "All your orders" : "All incoming orders"}
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="order-items" className={card}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 id="order-items" className="text-lg font-semibold">
              Items
            </h2>
            <Badge>{PHYSICAL_MERCH_LABEL}</Badge>
          </div>
          <OrderItems order={order} />
          <p role="note" className={`${notice.caution} mt-4`}>
            {SIMULATED_PAYMENT_NOTICE}
          </p>
        </section>

        <div className="flex flex-col gap-6">
          <section aria-labelledby="order-status" className={card}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="order-status" className="text-lg font-semibold">
                Fulfilment
              </h2>
              <OrderStatusBadge status={order.status} />
            </div>
            <p className="mt-2 text-sm">{FULFILMENT_TEXT[order.status]}</p>
            <p className="mt-1 text-sm text-muted">Last updated {formatOrderDate(order.updatedAt)}</p>
            {isSeller ? (
              <div className="mt-4 border-t border-border pt-4">
                <OrderStatusControls orderId={order.id} status={order.status} />
              </div>
            ) : null}
          </section>

          <section aria-labelledby="order-delivery" className={card}>
            <h2 id="order-delivery" className="text-lg font-semibold">
              Delivery
            </h2>
            <p className="mt-2 text-sm font-medium">{order.shippingName}</p>
            <p className="whitespace-pre-line text-sm text-muted">{order.shippingAddress}</p>
          </section>
        </div>
      </div>
    </>
  );
}
