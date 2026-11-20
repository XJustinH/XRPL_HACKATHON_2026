import { CustomerProfilePatch } from "@/contracts";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import {
  getCustomerPreferences,
  updateCustomerPreferences,
} from "@/features/profiles/customer-preferences";

/** Only the two preference fields; the rest of the profile is XRPL-056. */
const PreferencesPatch = CustomerProfilePatch.pick({ interests: true, city: true });

/**
 * GET /api/profiles/customers/me/preferences — the caller's own preferences.
 *
 * Any signed-in role may hold preferences: a seller browses events too.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await getCustomerPreferences(db, session.userId), { requestId });
});

/**
 * PATCH /api/profiles/customers/me/preferences — set or clear preferences.
 *
 * The account is the session's own; there is no id anywhere in the request, so
 * this cannot be pointed at another user. An empty array or empty string is a
 * valid "clear this" rather than a missing value.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);

  const patch = await parseJsonBody(req, PreferencesPatch);
  return jsonOk(await updateCustomerPreferences(db, session.userId, patch), { requestId });
});
