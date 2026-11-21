export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 9a2 2 0 0 0 0 6v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2a2 2 0 0 0 0-6V7a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1z" />
          <path d="M14 6v12" strokeDasharray="2 3" />
        </svg>
      </div>
      <p className="text-lg font-semibold">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * Marks a surface that is intentionally not built yet.
 *
 * Used so an unfinished area is visibly unfinished rather than looking like a
 * broken or empty feature.
 */
export function NotImplementedNotice({
  title,
  blockedBy,
}: {
  title: string;
  blockedBy: string;
}) {
  return (
    <div
      role="status"
      className="rounded-card border border-border bg-caution-soft px-5 py-4 text-sm text-caution"
    >
      <p className="font-semibold">{title} — not implemented yet</p>
      <p className="mt-1">Waiting on {blockedBy}.</p>
    </div>
  );
}
