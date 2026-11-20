import { CheckInScanRequest } from "@/contracts/checkin";
import { checkInResponse } from "@/features/checkin/http";
import { getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/verify: organiser scans a QR at the gate for `eventId` (XRPL-046).
 * Read-only: checks code, organiser, event, wallet proof and current XRPL ownership.
 * 200 { status: "VERIFIED", ... }
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const { qrPayload, eventId } = await parseJsonBody(req, CheckInScanRequest);
  const result = await getCheckInService().verifyScan({ qrPayload, gateEventId: eventId, organiserId: session.userId });
  return checkInResponse(result, 200, requestId);
});
