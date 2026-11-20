import type { DemoPersonasResponse } from "@/contracts";
import { listDemoPersonas } from "@/lib/auth/onboarding";
import { getDb } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/auth/demo-personas — seeded demo accounts that can be used without a
 * wallet. `enabled: false` (empty list) when DEMO_LOGIN_ENABLED is off.
 */
export const GET = withApiHandler(async (_req, _ctx, { requestId }) => {
  const enabled = getServerEnv().DEMO_LOGIN_ENABLED;
  const body: DemoPersonasResponse = {
    enabled,
    personas: enabled ? await listDemoPersonas(getDb()) : [],
  };
  return jsonOk(body, { requestId, headers: { "Cache-Control": "no-store" } });
});
