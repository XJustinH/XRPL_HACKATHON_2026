"use client";

import { useEffect, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { TicketOwnership } from "@/contracts/xrpl";

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** What a ticket's ownership looks like to the viewer. Never "owned" unless VERIFIED. */
export function ownershipLabel(ownership: TicketOwnership): {
  label: string;
  tone: BadgeTone;
  detail: string | null;
} {
  switch (ownership.status) {
    case "VERIFIED":
      return ownership.ownedByViewer
        ? { label: "In your wallet", tone: "positive", detail: null }
        : { label: `Held by ${shortAddress(ownership.ownerAddress ?? "")}`, tone: "neutral", detail: null };
    case "PENDING":
      return { label: "Ownership pending", tone: "caution", detail: ownership.detail };
    case "NOT_MINTED":
      return { label: "Not minted yet", tone: "neutral", detail: null };
    case "BURNED":
      return { label: "No longer exists", tone: "critical", detail: ownership.detail };
  }
}

/**
 * A ticket's current owner, read from a validated XRP Ledger when shown (XRPL-028), via
 * `GET /api/tickets/:id/ownership`. Shows "Ownership pending" (never "owned") when the ledger
 * can't confirm it, and notes when the ticket changed hands since the app last looked.
 * Agent C's My tickets and ticket view (XRPL-033/034) can render it next to each ticket.
 */
export function OwnershipBadge({ ticketId }: { ticketId: string }) {
  const [ownership, setOwnership] = useState<TicketOwnership | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    fetch(`/api/tickets/${ticketId}/ownership`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { data?: TicketOwnership };
        if (!response.ok || !body.data) throw new Error(`HTTP ${response.status}`);
        return body.data;
      })
      .then(
        (latest) => {
          if (current) setOwnership(latest);
        },
        () => {
          if (current) setFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [ticketId]);

  if (failed) {
    return (
      <span className="inline-flex flex-col gap-1">
        <Badge tone="caution">Ownership pending</Badge>
        <span className="text-xs text-muted">The ledger couldn&apos;t be checked just now.</span>
      </span>
    );
  }
  if (!ownership) {
    return (
      <span role="status" className="text-xs text-muted">
        Checking the ledger…
      </span>
    );
  }

  const { label, tone, detail } = ownershipLabel(ownership);
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {ownership.changed && ownership.status === "VERIFIED" ? (
          <span className="text-xs text-muted">Changed hands since the last check</span>
        ) : null}
      </span>
      {detail ? <span className="text-xs text-muted">{detail}</span> : null}
    </span>
  );
}
