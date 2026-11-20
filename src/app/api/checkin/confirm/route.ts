import { CheckInScanRequest } from "@/contracts/checkin";
import { checkInResponse } from "@/features/checkin/http";
import { getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/confirm: organiser admits the attendee (XRPL-047).
 * Re-runs every check, then records the check-in once. A repeat returns 409 ALREADY_USED,
 * so retrying after a network error is safe.
 * 201 { status: "ADMITTED", ticketId, eventId, checkedInAt, ledgerIndex }
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const { qrPayload, eventId } = await parseJsonBody(req, CheckInScanRequest);
  const result = await getCheckInService().admit({ qrPayload, gateEventId: eventId, organiserId: session.userId });
  return checkInResponse(result, 201, requestId);
});
