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
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-12 text-center">
      <p className="text-base font-medium">{title}</p>
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
