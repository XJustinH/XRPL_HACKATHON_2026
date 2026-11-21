// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FriendService } from "./friend-service";
import { unavailableFriendStore } from "./server";
import { FakeDirectory, InMemoryFriendStore } from "./testing/fakes";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let session: { userId: string } | null = null;
let service: FriendService;
let users: FakeDirectory;

vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    getRequestSession: async () => session,
    requireSession: async () => {
      if (!session) throw errors.unauthenticated();
      return session;
    },
  };
});
vi.mock("@/features/friends/server", async (orig) => ({
  ...(await orig<typeof import("./server")>()),
  getFriendService: () => service,
}));

const { GET: overviewGET } = await import("@/app/api/friends/route");
const { POST: requestPOST } = await import("@/app/api/friends/requests/route");
const { POST: respondPOST } = await import("@/app/api/friends/requests/[id]/respond/route");
const { DELETE: removeDELETE } = await import("@/app/api/friends/[userId]/route");
const { POST: blockPOST } = await import("@/app/api/friends/blocks/route");
const { DELETE: unblockDELETE } = await import("@/app/api/friends/blocks/[userId]/route");
const { PATCH: settingsPATCH } = await import("@/app/api/friends/settings/route");
const { GET: friendsOfGET } = await import("@/app/api/users/[id]/friends/route");

const req = (method: string, body?: unknown, origin?: string) =>
  new Request("http://localhost/api/friends", {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  users = new FakeDirectory();
  users.add(A, "Aoife");
  users.add(B, "Brian");
  service = new FriendService({ store: new InMemoryFriendStore(), users });
  session = { userId: A };
});

describe("friends routes (XRPL-084)", () => {
  it("request, accept, list, remove", async () => {
    const sent = await json(await requestPOST(req("POST", { userId: B }), {}));
    expect(sent).toMatchObject({ status: 201, body: { data: { status: "PENDING" } } });

    session = { userId: B };
    const accepted = await json(await respondPOST(req("POST", { accept: true }), params("id", sent.body.data.requestId)));
    expect(accepted.body.data).toMatchObject({ status: "ACCEPTED" });

    session = { userId: A };
    const overview = await json(await overviewGET(req("GET"), {}));
    expect(overview.body.data).toMatchObject({ myCode: A, friends: [{ userId: B, displayName: "Brian" }] });

    expect((await removeDELETE(req("DELETE"), params("userId", B))).status).toBe(200);
    expect((await json(await overviewGET(req("GET"), {}))).body.data.friends).toEqual([]);
  });

  it("asking back returns 200 ACCEPTED", async () => {
    await requestPOST(req("POST", { userId: B }), {});
    session = { userId: B };
    expect(await json(await requestPOST(req("POST", { userId: A }), {}))).toMatchObject({ status: 200, body: { data: { status: "ACCEPTED" } } });
  });

  it("block and unblock", async () => {
    expect((await blockPOST(req("POST", { userId: B }), {})).status).toBe(201);
    session = { userId: B };
    expect((await json(await requestPOST(req("POST", { userId: A }), {}))).body.error.code).toBe("FRIEND_REQUEST_NOT_ALLOWED");
    session = { userId: A };
    expect((await unblockDELETE(req("DELETE"), params("userId", B))).status).toBe(200);
  });

  it("friend list visibility follows the owner's setting", async () => {
    await requestPOST(req("POST", { userId: B }), {});
    session = { userId: B };
    const incoming = (await json(await overviewGET(req("GET"), {}))).body.data.incoming;
    await respondPOST(req("POST", { accept: true }), params("id", incoming[0].requestId));

    expect((await json(await friendsOfGET(req("GET"), params("id", A)))).body.data).toEqual({ userId: A, visible: false, friends: [] });
    session = { userId: A };
    expect((await settingsPATCH(req("PATCH", { friendsVisibility: "FRIENDS" }), {})).status).toBe(200);
    session = { userId: B };
    expect((await json(await friendsOfGET(req("GET"), params("id", A)))).body.data.visible).toBe(true);
  });

  it("validates input and requires sign-in", async () => {
    expect((await requestPOST(req("POST", { userId: "nope" }), {})).status).toBe(400);
    expect((await settingsPATCH(req("PATCH", { friendsVisibility: "EVERYONE" }), {})).status).toBe(400);
    expect((await respondPOST(req("POST", { accept: true }), params("id", "nope"))).status).toBe(400);
    session = null;
    expect((await overviewGET(req("GET"), {})).status).toBe(401);
    expect((await requestPOST(req("POST", { userId: B }), {})).status).toBe(401);
  });

  it("rejects cross-site writes", async () => {
    expect((await requestPOST(req("POST", { userId: B }, "https://evil.example"), {})).status).toBe(403);
  });

  it("answers 503 until the friendship tables exist", async () => {
    service = new FriendService({ store: unavailableFriendStore, users });
    expect((await overviewGET(req("GET"), {})).status).toBe(503);
    expect((await requestPOST(req("POST", { userId: B }), {})).status).toBe(503);
  });
});
