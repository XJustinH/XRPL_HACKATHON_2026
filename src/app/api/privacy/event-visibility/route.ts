import { z } from "zod";
import { AppId } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { ActivityVisibility } from "@/features/privacy/visibility";
import {
  getVisibilitySettings,
  updateVisibilitySettings,
} from "@/features/privacy/friend-activity";

/**
 * Attendance and saved-event visibility (XRPL-088).
 *
 * The account changed is always the session's own — there is no user id
 * anywhere in the request, so this route cannot alter anyone else's privacy.
 */
const VisibilityPatch = z.object({
  attendanceVisibility: ActivityVisibility.optional(),
  wishlistVisibility: ActivityVisibility.optional(),
  event: z
    .object({
      eventId: AppId,
      kind: z.enum(["attendance", "wishlist"]),
      /** Null clears the override so the global setting applies again. */
      value: ActivityVisibility.nullable(),
    })
    .optional(),
});

export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await getVisibilitySettings(db, session.userId), { requestId });
});

export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const patch = await parseJsonBody(req, VisibilityPatch);
  return jsonOk(await updateVisibilitySettings(db, session.userId, patch), { requestId });
});
