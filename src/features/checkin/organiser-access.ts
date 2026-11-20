/**
 * Who may scan tickets at an event's gate (and see its organiser dashboards).
 *
 * Delegates to Agent A's permission rule (XRPL-013, `isEventOwner` in
 * src/lib/auth/permissions.ts): the event's owner, i.e. the account that created it, while it
 * is a SELLER or ORGANISER. Kept as a class so existing call sites don't change.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { isEventOwner } from "@/lib/auth/permissions";
import type { OrganiserAccess } from "./ports";

export class EventSellerAccess implements OrganiserAccess {
  constructor(private readonly db: Pick<PrismaClient, "event">) {}

  canScanEvent(userId: string, eventId: string): Promise<boolean> {
    return isEventOwner(this.db, userId, eventId);
  }
}
