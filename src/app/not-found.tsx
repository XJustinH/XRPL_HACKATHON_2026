import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you were looking for does not exist, or it may not be published."
      action={
        <Link
          href="/"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink"
        >
          Back to discover
        </Link>
      }
    />
  );
}
