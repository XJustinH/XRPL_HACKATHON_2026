/**
 * Who may scan tickets at an event's gate.
 *
 * Interim rule until roles land (XRPL-013, Agent A): the event's own seller, if their
 * role is SELLER or ORGANISER. There is no organiser-to-event assignment table yet, so
 * a standalone ORGANISER account cannot be granted a specific event. Replace this with
 * Agent A's role check when it exists.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OrganiserAccess } from "./ports";

export class EventSellerAccess implements OrganiserAccess {
  constructor(private readonly db: Pick<PrismaClient, "event">) {}

  async canScanEvent(userId: string, eventId: string): Promise<boolean> {
    const event = await this.db.event.findUnique({
      where: { id: eventId },
      select: { sellerId: true, seller: { select: { role: true } } },
    });
    if (!event || event.sellerId !== userId) return false;
    return event.seller.role === "SELLER" || event.seller.role === "ORGANISER";
  }
}
