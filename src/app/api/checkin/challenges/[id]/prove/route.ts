import { z } from "zod";
import { CheckInProveRequest } from "@/contracts/checkin";
import { checkInResponse } from "@/features/checkin/http";
import { getCheckInService } from "@/features/checkin/server";
import { requireSession } from "@/lib/auth/session";
import { parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/checkin/challenges/:id/prove: attendee submits the wallet-signed proof (XRPL-045).
 * Body: { proof }. 200 { status: "PROVEN" }. The proof itself must come from the ticket's wallet.
 */
export const POST = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  await requireSession(req);
  const challengeId = z.uuid().parse((await ctx.params).id);
  const { proof } = await parseJsonBody(req, CheckInProveRequest);
  return checkInResponse(await getCheckInService().proveControl({ challengeId, proof }), 200, requestId);
});
