/**
 * Developer test transactions (XRPL-014): a no-op AccountSet that lets the team check the
 * whole approval flow (sign in Xaman, submit, validate, explorer link) before real mint,
 * offer and purchase actions exist.
 *
 * XRPL_TEST_TRANSACTIONS_ENABLED=true|false. Defaults to on outside production and off in
 * production, the same rule as DEMO_LOGIN_ENABLED.
 */
export function testTransactionsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.XRPL_TEST_TRANSACTIONS_ENABLED?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return env.NODE_ENV !== "production";
}

/** Shown in Xaman for the developer test transaction. */
export const TEST_TRANSACTION_INSTRUCTION =
  "Developer check: approve a no-op AccountSet. It changes nothing on your account and only costs the network fee (about 0.00001 test XRP).";
