import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";

import { requestHash, runIdempotent } from "./idempotency";

/** Idempotency-Key handling against Postgres (`npm run test:db`). */

const db = getDb();
const scope = (key: string | null, request: unknown = { tierId: "a" }) => ({
  key,
  scope: "user-1",
  route: "POST /api/events/:id/mints",
  request,
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE "IdempotencyRecord"`);
});
afterAll(async () => {
  await db.$disconnect();
});

describe("runIdempotent", () => {
  it("runs once per key and replays the stored response", async () => {
    const operation = vi.fn(async () => ({ status: 201, body: { ticket: "t1" } }));

    expect(await runIdempotent(db, scope("key-12345"), operation)).toEqual({
      status: 201,
      body: { ticket: "t1" },
      replayed: false,
    });
    expect(await runIdempotent(db, scope("key-12345"), operation)).toEqual({
      status: 201,
      body: { ticket: "t1" },
      replayed: true,
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("keeps keys separate per user", async () => {
    const operation = vi.fn(async () => ({ status: 201, body: {} }));
    await runIdempotent(db, scope("key-12345"), operation);
    await runIdempotent(db, { ...scope("key-12345"), scope: "user-2" }, operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects a key reused for a different request", async () => {
    await runIdempotent(db, scope("key-12345"), async () => ({ status: 201, body: {} }));
    await expect(
      runIdempotent(db, scope("key-12345", { tierId: "b" }), async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("answers 409 while the first request is still running", async () => {
    let finish: () => void = () => {};
    const first = runIdempotent(db, scope("key-12345"), async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return { status: 201, body: {} };
    });
    await vi.waitFor(async () => expect(await db.idempotencyRecord.count()).toBe(1));

    await expect(
      runIdempotent(db, scope("key-12345"), async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ status: 409 });
    finish();
    await first;
  });

  it("releases the key when the operation fails, so a retry runs", async () => {
    await expect(
      runIdempotent(db, scope("key-12345"), async () => {
        throw new Error("Xaman down");
      }),
    ).rejects.toThrow("Xaman down");
    const retry = await runIdempotent(db, scope("key-12345"), async () => ({
      status: 201,
      body: { ok: true },
    }));
    expect(retry).toMatchObject({ replayed: false, body: { ok: true } });
  });

  it("runs again once a stored response has expired", async () => {
    await runIdempotent(db, scope("key-12345"), async () => ({ status: 201, body: { n: 1 } }));
    await db.idempotencyRecord.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const again = await runIdempotent(db, scope("key-12345"), async () => ({ status: 201, body: { n: 2 } }));
    expect(again).toMatchObject({ replayed: false, body: { n: 2 } });
  });

  it("runs every time without a key, and rejects a malformed key", async () => {
    const operation = vi.fn(async () => ({ status: 201, body: {} }));
    await runIdempotent(db, scope(null), operation);
    await runIdempotent(db, scope(null), operation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(await db.idempotencyRecord.count()).toBe(0);
    await expect(runIdempotent(db, scope("short"), operation)).rejects.toMatchObject({ status: 400 });
  });

  it("hashes requests independently of key order", () => {
    expect(requestHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(requestHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});
