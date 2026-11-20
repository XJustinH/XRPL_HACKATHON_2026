import { PageHeader } from "@/components/ui/page-header";

/** Skeleton shown while the event listing is being fetched (XRPL-018). */
export default function Loading() {
  return (
    <>
      <PageHeader title="Discover events" />
      <p className="sr-only" role="status">
        Loading events
      </p>
      <ul aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <li
            key={index}
            className="overflow-hidden rounded-card border border-border bg-surface-raised"
          >
            <div className="aspect-[16/9] w-full bg-surface" />
            <div className="flex flex-col gap-2 p-4">
              <div className="h-4 w-3/4 rounded bg-surface" />
              <div className="h-3 w-1/2 rounded bg-surface" />
              <div className="h-3 w-2/3 rounded bg-surface" />
              <div className="mt-2 h-5 w-24 rounded-full bg-surface" />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
