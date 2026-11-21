import { AppId } from "@/contracts/common";
import { errors } from "@/lib/http/response";

export type IdCtx = { params: Promise<{ id: string }> };

/** The `:id` path segment, or a 404 when it is not a well-formed id (it never reaches a uuid column). */
export async function idParam(ctx: IdCtx, message = "Not found"): Promise<string> {
  const parsed = AppId.safeParse((await ctx.params).id);
  if (!parsed.success) throw errors.notFound(message);
  return parsed.data;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
