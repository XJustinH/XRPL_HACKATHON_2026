import { AppId } from "@/contracts/common";
import { errors } from "@/lib/http/response";

/** Small helpers shared by the collectible route handlers. */

export type IdContext = { params: Promise<{ id: string }> };
export const NO_STORE = { "Cache-Control": "no-store" };

/** The route's `:id`, or 404 when it is not a UUID (so a bad ID never reaches the database). */
export async function idOf(ctx: IdContext, notFoundMessage = "Collectible not found"): Promise<string> {
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound(notFoundMessage);
  return id;
}
