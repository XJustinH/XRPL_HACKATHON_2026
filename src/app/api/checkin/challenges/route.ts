import { CheckInChallengeRequest } from "@/contracts/checkin";
import { checkInResponse, walletNotVerified } from "@/features/checkin/http";
import { getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/challenges: attendee requests a 2-minute check-in QR (XRPL-044).
 * Body: { ticketId }. The wallet is the session's verified wallet, never request input.
 * 201 { challengeId, qrPayload, messageToSign, expiresAt, ... }
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  if (!session.walletAddress) throw walletNotVerified();
  const { ticketId } = await parseJsonBody(req, CheckInChallengeRequest);
  const result = await getCheckInService().issueChallenge({ ticketId, walletAddress: session.walletAddress });
  return checkInResponse(result, 201, requestId);
});
