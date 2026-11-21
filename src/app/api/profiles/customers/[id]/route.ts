import { AppId } from "@/contracts/common";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { getPublicCustomerProfile } from "@/features/profiles/public-customer-profile";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profiles/customers/:id — a customer profile, obeying their own
 * public/private choice (XRPL-087).
 *
 * A hidden profile returns the display name and `visible: false` with no
 * detail, rather than 404. The account exists either way, so pretending it does
 * not would be a lie a friend request would immediately contradict.
 */
export const GET = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Profile not found");

  const db = getDb();
  const session = await getRequestSession(req, db);
  const profile = await getPublicCustomerProfile(db, {
    userId: id,
    viewerId: session?.userId ?? null,
  });
  if (!profile) throw errors.notFound("Profile not found");

  return jsonOk(profile, { requestId, headers: { "Cache-Control": "no-store" } });
});
