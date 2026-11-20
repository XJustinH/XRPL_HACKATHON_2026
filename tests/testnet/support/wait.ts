/**
 * Polls `probe` until `done` holds. Ledger outcomes arrive asynchronously, so the suite waits for
 * the outcome itself rather than sleeping for a fixed time: it continues as soon as the result is
 * final, and fails with the last observed value if it never gets there.
 */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { what, timeoutMs = 60_000, intervalMs = 1_000 }: { what: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}. Last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
