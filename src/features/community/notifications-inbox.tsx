"use client";

import Link from "next/link";
import { useState } from "react";
import type { NotificationInbox as InboxData } from "@/contracts/community";
import { requestJson } from "@/features/events/api-client";
import { card, notice, secondaryButton } from "@/features/wallet/styles";
import { formatDate, linkButton } from "./client";

/**
 * The notifications inbox (XRPL-093): what followed sellers announced, read state, and the switch
 * that turns these optional notifications off.
 */
export function NotificationsInbox({ initial }: { initial: InboxData }) {
  const [items, setItems] = useState(initial.items);
  const [optedOut, setOptedOut] = useState(initial.optedOut);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unread = items.filter((item) => item.readAt === null).length;

  async function markRead(id: string) {
    setError(null);
    const result = await requestJson<{ id: string }>(`/api/notifications/${id}/read`, { method: "POST" });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => (item.id === id ? { ...item, readAt } : item)));
  }

  async function markAllRead() {
    setError(null);
    const result = await requestJson<{ marked: number }>("/api/notifications/read-all", { method: "POST" });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => (item.readAt ? item : { ...item, readAt })));
  }

  async function toggleOptOut(next: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await requestJson<{ optedOut: boolean }>("/api/notifications/settings", {
      method: "PATCH",
      body: { optOut: next },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOptedOut(result.data.optedOut);
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="notification-settings-heading" className={card}>
        <h2 id="notification-settings-heading" className="text-lg font-semibold">
          Settings
        </h2>
        <label className="mt-2 flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={!optedOut}
            disabled={pending}
            onChange={(event) => toggleOptOut(!event.target.checked)}
          />
          <span>Notify me about new events and posts from accounts I follow</span>
        </label>
        {optedOut ? (
          <p className="mt-1 text-sm text-muted">
            Notifications are off. You will not get new ones until you turn them back on.
          </p>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className={notice.critical}>
          {error}
        </p>
      ) : null}

      <section aria-labelledby="inbox-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="inbox-heading" className="text-lg font-semibold">
            {unread === 0 ? "No unread notifications" : `${unread} unread`}
          </h2>
          {unread > 0 ? (
            <button type="button" onClick={markAllRead} className={`min-h-11 ${secondaryButton}`}>
              Mark all read
            </button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
            Nothing yet. When an account you follow announces an event, it shows up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => {
              const isUnread = item.readAt === null;
              return (
                <li
                  key={item.id}
                  className={`rounded-card border p-4 ${isUnread ? "border-accent bg-accent-soft" : "border-border bg-surface-raised"}`}
                >
                  <p className="text-sm text-muted">
                    {isUnread ? <span className="font-semibold text-accent">New · </span> : null}
                    {formatDate(item.createdAt)}
                  </p>
                  <p className={`mt-1 text-sm ${isUnread ? "font-semibold" : ""}`}>
                    {item.seller.displayName}{" "}
                    {item.kind === "NEW_EVENT" ? "announced a new event:" : "posted:"}{" "}
                    <Link href={item.href} className="text-accent underline underline-offset-2">
                      {item.title}
                    </Link>
                  </p>
                  {isUnread ? (
                    <button type="button" onClick={() => markRead(item.id)} className={linkButton}>
                      Mark read
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
