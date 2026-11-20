import { AppError, errors } from "@/lib/http/response";
import { TierRuleError } from "./event-store";

/**
 * Maps a tier domain rule to its HTTP response.
 *
 * Kept out of the route handlers so the create, edit and delete routes cannot
 * disagree about which rule is a 404 and which is a 409.
 */
export function toTierHttpError(error: unknown): unknown {
  if (!(error instanceof TierRuleError)) return error;
  switch (error.code) {
    case "TIER_NOT_FOUND":
      return errors.notFound(error.message);
    case "DUPLICATE_TIER_NAME":
    case "TIER_LOCKED":
    case "SUPPLY_BELOW_MINTED":
    case "TIER_HAS_TICKETS":
      // All four are conflicts with current state, not malformed input, so the
      // seller's submission was valid but cannot be applied.
      return new AppError(error.code, error.message, 409);
  }
}
