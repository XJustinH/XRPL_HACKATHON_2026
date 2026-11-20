import Link from "next/link";

/** Switches between an event's organiser tools. */
export function OrganiserEventTabs({ eventId, current }: { eventId: string; current: "inventory" | "checkin" }) {
  const tabs = [
    { key: "inventory", label: "Inventory", href: `/organiser/events/${eventId}/inventory` },
    { key: "checkin", label: "Check-in", href: `/organiser/events/${eventId}/checkin` },
  ] as const;
  return (
    <nav aria-label="Event tools" className="mb-6 flex flex-wrap gap-2">
      <Link href="/organiser/events" className="min-h-11 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface">
        ← My events
      </Link>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold ${
            t.key === current ? "bg-accent text-accent-ink" : "border border-border hover:bg-surface"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
