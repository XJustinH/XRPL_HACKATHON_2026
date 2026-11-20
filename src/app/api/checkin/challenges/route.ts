import { CheckInChallengeRequest } from "@/contracts/checkin";
import { checkInResponse, walletNotVerified } from "@/features/checkin/http";
import { getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/challenges: attendee requests a 5-minute check-in QR (XRPL-044).
 * Body: { ticketId, walletAddress? }. Uses the session's verified wallet if there is one,
 * otherwise the named wallet; either must hold the ticket on XRPL, and the code only works
 * after that wallet approves it in Xaman.
 * 201 { challengeId, qrPayload, messageToSign, expiresAt, ... }
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const body = await parseJsonBody(req, CheckInChallengeRequest);
  const walletAddress = session.walletAddress ?? body.walletAddress;
  if (!walletAddress) throw walletNotVerified();
  const result = await getCheckInService().issueChallenge({ ticketId: body.ticketId, walletAddress });
  return checkInResponse(result, 201, requestId);
});
