import { z } from "zod";
import type { CheckInApprovalStarted } from "@/contracts/checkin";
import { checkInResponse } from "@/features/checkin/http";
import { getCheckInApproval, getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/challenges/:id/sign-request: start the Xaman approval for a check-in code (XRPL-045).
 * 201 { signRequest, proof }. The attendee approves in Xaman, the app polls
 * GET /api/wallet/sign-requests/:id until SIGNED, then posts `proof` to .../prove.
 * A Xaman SignIn moves no funds and is never submitted to the ledger.
 */
export const POST = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  await requireSession(req);
  const challengeId = z.uuid().parse((await ctx.params).id);

  const approvable = await getCheckInService().checkApprovable(challengeId);
  if (approvable.status !== "APPROVABLE") return checkInResponse(approvable, 201, requestId);

  const approval = getCheckInApproval();
  const signRequest = await approval.createSignIn();
  const started: CheckInApprovalStarted = { signRequest, proof: approval.tokenFor(challengeId, signRequest.id) };
  return checkInResponse(started, 201, requestId);
});
