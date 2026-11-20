import { z } from "zod";
import { isEventOwner } from "@/lib/auth/permissions";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";

/**
 * Same visibility rule as GET /api/events/:id/availability: published events are public; a draft
 * is visible only to its owner, and everyone else gets 404 so drafts can't be discovered.
 */
export async function resolveVisibleEventId(req: Request, rawId: string): Promise<string> {
  const parsed = z.uuid().safeParse(rawId);
  if (!parsed.success) throw errors.notFound("Event not found");
  const db = getDb();
  const event = await db.event.findUnique({ where: { id: parsed.data }, select: { status: true } });
  if (!event) throw errors.notFound("Event not found");
  if (event.status !== "PUBLISHED") {
    const session = await getRequestSession(req, db);
    if (!session || !(await isEventOwner(db, session.userId, parsed.data))) throw errors.notFound("Event not found");
  }
  return parsed.data;
}
