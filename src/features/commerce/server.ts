import type { PrismaClient } from "@/generated/prisma/client";
import { isEventOwner } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db/client";
import { PrismaProductStore } from "./product-store";
import type { CommerceDeps } from "./products";

/** The merchandise service wired to Postgres, for route handlers and server components. */
export function commerceDeps(db: PrismaClient = getDb()): CommerceDeps {
  return {
    products: new PrismaProductStore(db),
    events: { isEventOwner: (userId, eventId) => isEventOwner(db, userId, eventId) },
  };
}
