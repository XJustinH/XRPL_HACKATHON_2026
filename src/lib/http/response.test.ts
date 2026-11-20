import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, errors, getRequestId, jsonOk, parseJsonBody, toAppError, withApiHandler } from "./response";

const req = (init?: RequestInit & { headers?: Record<string, string> }) =>
  new Request("http://localhost/api/test", init);

describe("getRequestId", () => {
  it("reuses a safe incoming x-request-id", () => {
    expect(getRequestId(req({ headers: { "x-request-id": "abc-12345678" } }))).toBe("abc-12345678");
  });

  it("replaces an unsafe incoming id", () => {
    const id = getRequestId(req({ headers: { "x-request-id": "<script>" } }));
    expect(id).not.toBe("<script>");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("jsonOk", () => {
  it("wraps data and sets the request id header", async () => {
    const res = jsonOk({ a: 1 }, { status: 201, requestId: "req-12345678" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(await res.json()).toEqual({ data: { a: 1 } });
  });
});

describe("toAppError", () => {
  it("passes AppError through", () => {
    const e = errors.forbidden();
    expect(toAppError(e)).toBe(e);
  });

  it("maps ZodError to 400 with issue paths", () => {
    const r = z.object({ n: z.number() }).safeParse({ n: "x" });
    const e = toAppError(r.error);
    expect(e.status).toBe(400);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.details).toEqual([expect.objectContaining({ path: "n" })]);
  });

  it("maps Prisma unique violations to 409", () => {
    const prismaErr = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(toAppError(prismaErr).status).toBe(409);
  });

  it("hides unknown errors behind a generic 500", () => {
    const e = toAppError(new Error("password=hunter2 at db.internal"));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("hunter2");
  });
});

describe("withApiHandler", () => {
  it("returns the standard error envelope", async () => {
    const handler = withApiHandler(async () => {
      throw new AppError("WRONG_EVENT", "Ticket is for a different event", 409);
    });
    const res = await handler(req({ headers: { "x-request-id": "req-12345678" } }), {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "WRONG_EVENT", message: "Ticket is for a different event" },
      requestId: "req-12345678",
    });
  });

  it("logs and masks unexpected errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApiHandler(async () => {
      throw new Error("boom");
    });
    const res = await handler(req(), {});
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL", message: "Unexpected server error" });
    expect(typeof body.requestId).toBe("string");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("parseJsonBody", () => {
  const schema = z.object({ title: z.string().min(1) });

  it("parses valid bodies", async () => {
    const r = req({ method: "POST", body: JSON.stringify({ title: "Gig" }) });
    expect(await parseJsonBody(r, schema)).toEqual({ title: "Gig" });
  });

  it("rejects malformed JSON with INVALID_JSON", async () => {
    const r = req({ method: "POST", body: "{nope" });
    await expect(parseJsonBody(r, schema)).rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
  });

  it("surfaces schema failures as validation errors", async () => {
    const r = req({ method: "POST", body: JSON.stringify({ title: "" }) });
    const err = await parseJsonBody(r, schema).catch((e) => e);
    expect(toAppError(err).status).toBe(400);
  });
});
