import { connection } from "next/server";

import { AppId, IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { CreateMintBody } from "@/contracts/xrpl";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { runIdempotent } from "@/lib/xrpl/idempotency";
import { getEventMints, requestTicketMint } from "@/lib/xrpl/tickets/minting";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

async function eventIdOf(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Event not found");
  return id;
}

/**
 * POST /api/events/:id/mints: the event's owner mints the next ticket of a tier (XRPL-024).
 * Body { tierId }. The issuer is the session's proven wallet (XRPL-012).
 * 201 { data: MintRequestResult }: the reserved ticket plus a transaction request to approve
 * in Xaman. Send an `Idempotency-Key` header: a repeated key replays the first response
 * instead of reserving another ticket (`Idempotent-Replayed: true`).
 * 401 without a session · 404 unknown event · 403 NOT_EVENT_OWNER / WALLET_NOT_VERIFIED ·
 * 409 when the tier is full · 422 when the key was already used for a different request.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const eventId = await eventIdOf(ctx);
  const body = await parseJsonBody(req, CreateMintBody);
  const deps = mintingDeps();
  const result = await runIdempotent(
    deps.db,
    {
      key: req.headers.get(IDEMPOTENCY_KEY_HEADER),
      scope: session.userId,
      route: "POST /api/events/:id/mints",
      request: { eventId, ...body },
    },
    async () => ({
      status: 201,
      body: await withLedgerErrors(() => requestTicketMint(deps, { session, eventId, ...body })),
    }),
  );
  const headers = result.replayed ? { ...NO_STORE, "Idempotent-Replayed": "true" } : NO_STORE;
  return jsonOk(result.body, { requestId, status: result.status, headers });
});

/**
 * GET /api/events/:id/mints: every tier of the seller's event with its tickets, after
 * reconciling mints in flight (XRPL-024). 200 { data: EventMints }. Tickets are MINTED
 * only once the ledger validated their NFTokenMint.
 */
export const GET = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const eventId = await eventIdOf(ctx);
  const mints = await withLedgerErrors(() => getEventMints(mintingDeps(), { session, eventId }));
  return jsonOk(mints, { requestId, headers: NO_STORE });
});
