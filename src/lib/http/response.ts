import { ZodError } from "zod";
import { ErrorCode, type ApiErrorBody } from "@/contracts/common";

/**
 * Standard JSON envelope and error handling for every route handler. Owner: Agent A.
 *   success: { "data": ... }
 *   failure: { "error": { "code", "message", "details"? }, "requestId" }
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  validation: (details?: unknown, message = "Request validation failed") =>
    new AppError(ErrorCode.VALIDATION_FAILED, message, 400, details),
  unauthenticated: (message = "Sign in required") => new AppError(ErrorCode.UNAUTHENTICATED, message, 401),
  forbidden: (message = "You do not have permission to perform this action") =>
    new AppError(ErrorCode.FORBIDDEN, message, 403),
  notFound: (message = "Not found") => new AppError(ErrorCode.NOT_FOUND, message, 404),
  conflict: (message = "Conflicts with the current state", details?: unknown) =>
    new AppError(ErrorCode.CONFLICT, message, 409, details),
  unavailable: (message = "Service temporarily unavailable", details?: unknown) =>
    new AppError(ErrorCode.SERVICE_UNAVAILABLE, message, 503, details),
};

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Reuse a well-formed upstream request id, otherwise mint one. */
export function getRequestId(req?: Request): string {
  const incoming = req?.headers.get(REQUEST_ID_HEADER);
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}

type ResponseOptions = { status?: number; requestId?: string; headers?: HeadersInit };

export function jsonOk<T>(data: T, opts: ResponseOptions = {}): Response {
  const headers = new Headers(opts.headers);
  if (opts.requestId) headers.set(REQUEST_ID_HEADER, opts.requestId);
  return Response.json({ data }, { status: opts.status ?? 200, headers });
}

export function jsonError(err: AppError, requestId: string, headers?: HeadersInit): Response {
  const body: ApiErrorBody = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
    requestId,
  };
  const h = new Headers(headers);
  h.set(REQUEST_ID_HEADER, requestId);
  return Response.json(body, { status: err.status, headers: h });
}

/** Map any thrown value to a safe AppError. Unknown errors never leak internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return errors.validation(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (isPrismaKnownError(err)) {
    if (err.code === "P2002") return errors.conflict("A record with these unique values already exists");
    if (err.code === "P2025") return errors.notFound();
  }
  return new AppError(ErrorCode.INTERNAL, "Unexpected server error", 500);
}

// Duck-typed so this module does not depend on the generated Prisma client.
function isPrismaKnownError(err: unknown): err is { code: string; name: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

export type HandlerMeta = { requestId: string };

/**
 * Wrap a route handler so every failure is returned in the standard envelope.
 *   export const GET = withApiHandler(async (req, ctx, { requestId }) => jsonOk(data, { requestId }));
 */
export function withApiHandler<Ctx = unknown>(
  handler: (req: Request, ctx: Ctx, meta: HandlerMeta) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = getRequestId(req);
    try {
      return await handler(req, ctx, { requestId });
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.status >= 500) {
        console.error(`[${requestId}] ${req.method} ${new URL(req.url).pathname} failed`, err);
      }
      return jsonError(appErr, requestId);
    }
  };
}

/** Parse a JSON body against a Zod schema; malformed JSON and invalid shapes become 400s. */
export async function parseJsonBody<T>(req: Request, schema: { parse: (v: unknown) => T }): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError(ErrorCode.INVALID_JSON, "Request body must be valid JSON", 400);
  }
  return schema.parse(raw);
}
