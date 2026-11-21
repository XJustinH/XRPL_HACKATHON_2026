import Link from "next/link";
import { MERCH_ORDER_STATUS_LABELS, type MerchOrderDto, type MerchOrderStatus } from "@/contracts/commerce";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { card } from "@/features/wallet/styles";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

/** Order display pieces shared by the customer's order pages and the seller's order list. */

const STATUS_TONE: Record<MerchOrderStatus, BadgeTone> = {
  NEW: "accent",
  PROCESSING: "caution",
  SHIPPED: "accent",
  FULFILLED: "positive",
  CANCELLED: "critical",
};

/** What the status means for the person waiting on the parcel. */
export const FULFILMENT_TEXT: Record<MerchOrderStatus, string> = {
  NEW: "Order received. The seller hasn't started on it yet.",
  PROCESSING: "The seller is preparing your order.",
  SHIPPED: "Your order has been sent.",
  FULFILLED: "Delivered. This order is complete.",
  CANCELLED: "This order was cancelled and its items went back into stock.",
};

const xrp = (drops: string) => `${formatDropsAsXrp(drops)} XRP`;

export const formatOrderDate = (iso: string) =>
  new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso)) +
  " UTC";

export function OrderStatusBadge({ status }: { status: MerchOrderStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{MERCH_ORDER_STATUS_LABELS[status]}</Badge>;
}

export function OrderItems({ order }: { order: MerchOrderDto }) {
  return (
    <div>
      <ul className="divide-y divide-border text-sm">
        {order.items.map((item) => (
          <li key={item.productId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
            <span className="min-w-0">
              <span className="font-medium">{item.name}</span>{" "}
              <span className="text-muted">
                × {item.quantity} at {xrp(item.unitPriceDrops)}
              </span>
            </span>
            <span className="shrink-0 font-medium">{xrp(item.lineTotalDrops)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm">
        <span className="text-muted">Total</span>
        <span className="text-base font-semibold">{xrp(order.totalDrops)}</span>
      </p>
    </div>
  );
}

/** One order in a list. `counterparty` names the other side: the seller for a buyer, and vice versa. */
export function OrderCard({
  order,
  counterparty,
  children,
}: {
  order: MerchOrderDto;
  counterparty: string;
  children?: React.ReactNode;
}) {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <li className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">
              <Link href={`/orders/${order.id}`} className="hover:underline">
                Order {order.id.slice(0, 8)}
              </Link>
            </h3>
            <OrderStatusBadge status={order.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {counterparty} · {formatOrderDate(order.createdAt)} · {units} {units === 1 ? "item" : "items"}
          </p>
        </div>
        <p className="shrink-0 text-base font-semibold">{xrp(order.totalDrops)}</p>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </li>
  );
}
