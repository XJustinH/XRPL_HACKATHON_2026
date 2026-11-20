import { CustomerProfilePatch } from "@/contracts";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { getOwnCustomerProfile, updateOwnCustomerProfile } from "@/features/profiles/customer-profile";
import { ProfileNotFoundError } from "@/features/profiles/profile-store";

/** Name and avatar. City and interests have their own route (`./preferences`, XRPL-058). */
const OwnProfilePatch = CustomerProfilePatch.pick({ displayName: true, imageUrl: true });

const notFound = (error: unknown) => {
  if (error instanceof ProfileNotFoundError) throw errors.notFound(error.message);
  throw error;
};

/** GET /api/profiles/customers/me: the caller's own display name and avatar (XRPL-056). */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await getOwnCustomerProfile(db, session.userId).catch(notFound), { requestId });
});

/**
 * PATCH /api/profiles/customers/me: edit your own display name and avatar (XRPL-056).
 * There is no id in the path or body, so it can only ever edit the caller's own profile.
 * Other fields (e.g. role) are not accepted.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const patch = await parseJsonBody(req, OwnProfilePatch);
  return jsonOk(await updateOwnCustomerProfile(db, session.userId, patch).catch(notFound), { requestId });
});
