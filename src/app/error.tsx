"use client";

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-border bg-critical-soft px-6 py-10 text-center"
    >
      <p className="text-base font-semibold text-critical">Something went wrong</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-critical">
        The page could not be loaded. No transaction was sent as a result of this
        error.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink"
      >
        Try again
      </button>
    </div>
  );
}
