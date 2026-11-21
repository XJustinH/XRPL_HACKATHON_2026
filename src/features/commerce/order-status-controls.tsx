"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CANCEL_RESTOCK_NOTICE,
  MERCH_ORDER_STATUS_CHANGES,
  type MerchOrderDto,
  type MerchOrderStatus,
} from "@/contracts/commerce";
import { requestJson } from "@/features/events/api-client";
import { notice, primaryButton, secondaryButton } from "@/features/wallet/styles";

/**
 * The seller's status buttons for one order (XRPL-068). Only the changes the state machine allows
 * from the current status are offered, and the server enforces the same table and that the caller
 * is the order's seller. Cancelling says, before it happens, that the items go back into stock.
 */

const ACTION_LABEL: Record<MerchOrderStatus, string> = {
  NEW: "Mark as new",
  PROCESSING: "Mark as processing",
  SHIPPED: "Mark as shipped",
  FULFILLED: "Mark as fulfilled",
  CANCELLED: "Cancel order",
};

export function OrderStatusControls({ orderId, status }: { orderId: string; status: MerchOrderStatus }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = MERCH_ORDER_STATUS_CHANGES[status];

  if (next.length === 0) {
    return (
      <p className="text-sm text-muted">
        {status === "CANCELLED"
          ? "Cancelled. Its items were returned to stock."
          : "Fulfilled. No further changes."}
      </p>
    );
  }

  async function change(to: MerchOrderStatus) {
    if (pending) return;
    if (to === "CANCELLED" && !window.confirm(`Cancel this order? ${CANCEL_RESTOCK_NOTICE}`)) return;
    setPending(true);
    setError(null);
    const result = await requestJson<MerchOrderDto>(`/api/orders/${orderId}/status`, {
      method: "PATCH",
      body: { status: to },
    });
    setPending(false);
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {next.map((to) => (
          <button
            key={to}
            type="button"
            disabled={pending}
            className={`${to === "CANCELLED" ? secondaryButton : primaryButton} min-h-11`}
            onClick={() => change(to)}
          >
            {ACTION_LABEL[to]}
          </button>
        ))}
      </div>
      {next.includes("CANCELLED") ? <p className="text-sm text-muted">{CANCEL_RESTOCK_NOTICE}</p> : null}
      {error ? (
        <p role="alert" className={notice.critical}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
