/** Small helpers shared by the community client components. */

/**
 * The most useful message from a failed request: the first validation detail when there is one
 * ("A post can be at most 2000 characters"), otherwise the envelope's message.
 */
export function failureMessage(result: { message: string; details?: unknown }): string {
  const first: unknown = Array.isArray(result.details) ? result.details[0] : null;
  if (first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string") {
    return (first as { message: string }).message;
  }
  return result.message;
}

/** Fixed locale and time zone, so the server render and the browser agree on the text. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Text-style button with a 44px tap target, for secondary actions in a list. */
export const linkButton =
  "inline-flex min-h-11 items-center text-sm font-medium text-muted underline-offset-2 hover:text-accent hover:underline disabled:opacity-60";
