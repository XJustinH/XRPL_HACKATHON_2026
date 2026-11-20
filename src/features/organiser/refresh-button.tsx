"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Re-renders the server page so counts reflect the latest validated records. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface disabled:opacity-60"
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
