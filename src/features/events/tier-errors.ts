import { AppError, errors } from "@/lib/http/response";
import { EventRuleError, TierRuleError } from "./event-store";

/**
 * Maps an event state rule to its HTTP response.
 *
 * `NOT_PUBLISHABLE` carries the full blocker list so the seller sees everything
 * outstanding rather than one problem per attempt.
 */
export function toEventHttpError(error: unknown): unknown {
  if (!(error instanceof EventRuleError)) return error;
  switch (error.code) {
    case "EVENT_NOT_FOUND":
      return errors.notFound(error.message);
    case "FIELDS_LOCKED_BY_MINT":
    case "NOT_PUBLISHABLE":
    case "ALREADY_PUBLISHED":
    case "NOT_PUBLISHED":
    case "HAS_MINTED_TICKETS":
      return new AppError(error.code, error.message, 409, error.details);
  }
}

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
