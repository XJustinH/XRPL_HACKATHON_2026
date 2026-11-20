import type { AppId, Drops } from "./common";
import type { EventAvailability } from "./events";

/**
 * Primary inventory and sell-out state (XRPL-020). Owner: Agent A.
 * Rules: src/lib/inventory/README.md.
 *
 * Only a validated primary sale (`TicketNFT.primarySoldAt`) counts as sold. Pending purchases,
 * unminted supply and tickets behind expired or cancelled offers all stay "remaining".
 */
export type TierAvailability = {
  tierId: AppId;
  name: string;
  /** Face value of the tier. */
  priceDrops: Drops;
  totalSupply: number;
  /** Units with a validated primary sale. */
  sold: number;
  /** `totalSupply - sold`. Includes unminted supply and pending purchases. */
  remaining: number;
  /** Remaining units with a purchase submitted to the ledger but not validated yet. */
  pending: number;
  /** Cheapest ACTIVE primary sell offer in this tier, or null when none is live. */
  fromPriceDrops: Drops | null;
};

/**
 * GET /api/events/:id/availability. Extends `EventAvailability` (src/contracts/events.ts), which is
 * what `InventoryPort.getAvailability` returns to the UI and the resale policy (XRPL-037).
 * `isSoldOut` is true only when the event has supply and every unit has a validated primary sale.
 */
export type PrimaryAvailability = EventAvailability & {
  /** Units with a purchase in flight (counted in `remaining`, never in `sold`). */
  pending: number;
  tiers: TierAvailability[];
};
