import { AppId } from "@/contracts/common";
import { errors } from "@/lib/http/response";

/** Shared by the merchandise route handlers (src/app/api/products, orders, sellers, cart). */

export type IdContext = { params: Promise<{ id: string }> };

export const NO_STORE = { "Cache-Control": "no-store" };

/** The route's `:id`, or 404 when it isn't an app id (so a malformed id never reaches the database). */
export async function idParam(ctx: IdContext, what: string): Promise<string> {
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound(`${what} not found`);
  return id;
}
