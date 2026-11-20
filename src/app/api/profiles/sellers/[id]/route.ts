import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { getSellerProfile, ProfileNotFoundError } from "@/features/profiles/profile-store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profiles/sellers/:id — public seller profile (XRPL-055).
 *
 * Public by design: this is a storefront landing page. Only the fields a seller
 * chose to publish are returned — never their wallet, email or session state.
 */
export const GET = withApiHandler<Ctx>(async (_req, ctx, { requestId }) => {
  const { id } = await ctx.params;
  try {
    const profile = await getSellerProfile(getDb(), id);
    return jsonOk(profile, { requestId });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) throw errors.notFound(error.message);
    throw error;
  }
});
