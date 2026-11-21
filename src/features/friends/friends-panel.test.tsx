import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FriendsOverview } from "@/contracts/friends";
import { FriendsPanel } from "./friends-panel";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const overview = (over: Partial<FriendsOverview> = {}): FriendsOverview => ({
  myCode: ME,
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  friendsVisibility: "ONLY_ME",
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("FriendsPanel (XRPL-084)", () => {
  it("shows your code and sends a request by code", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: overview() }))
      .mockResolvedValueOnce(json(201, { data: { status: "PENDING", requestId: "r1" } }))
      .mockResolvedValueOnce(json(200, { data: overview({ outgoing: [{ requestId: "r1", userId: B, displayName: "Brian", sentAt: "2026-12-01T10:00:00Z" }] }) }));
    render(<FriendsPanel />);

    expect(await screen.findByText(ME)).toBeInTheDocument();
    expect(screen.getByText("No friends yet. Share your code or add someone's.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Their friend code"), B);
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Friend request sent.");
    expect(await screen.findByRole("button", { name: "Cancel Brian" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/friends/requests");
    expect(JSON.parse(init.body)).toEqual({ userId: B });
  });

  it("accepts an incoming request", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: overview({ incoming: [{ requestId: "r9", userId: B, displayName: "Brian", sentAt: "2026-12-01T10:00:00Z" }] }) }))
      .mockResolvedValueOnce(json(200, { data: { status: "ACCEPTED", requestId: "r9" } }))
      .mockResolvedValueOnce(json(200, { data: overview({ friends: [{ userId: B, displayName: "Brian", since: "2026-12-01T10:05:00Z" }] }) }));
    render(<FriendsPanel />);
    await user.click(await screen.findByRole("button", { name: "Accept Brian" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You're now friends.");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/friends/requests/r9/respond");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ accept: true });
    expect(await screen.findByRole("button", { name: "Block Brian" })).toBeInTheDocument();
  });

  it("changes who can see your friends", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: overview() }))
      .mockResolvedValueOnce(json(200, { data: { friendsVisibility: "FRIENDS" } }))
      .mockResolvedValueOnce(json(200, { data: overview({ friendsVisibility: "FRIENDS" }) }));
    render(<FriendsPanel />);
    expect(await screen.findByLabelText("Only me")).toBeChecked();
    await user.click(screen.getByLabelText("My friends"));
    expect(await screen.findByRole("status")).toHaveTextContent("Your friends can now see your friend list.");
    expect(fetchMock.mock.calls[1]![1].method).toBe("PATCH");
  });

  it("shows the server's error for a failed action", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: overview() }))
      .mockResolvedValueOnce(json(404, { error: { code: "USER_NOT_FOUND", message: "No one has that friend code." }, requestId: "r" }))
      .mockResolvedValueOnce(json(200, { data: overview() }));
    render(<FriendsPanel />);
    await user.type(await screen.findByLabelText("Their friend code"), "nope");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No one has that friend code.");
  });

  it("explains when friends aren't available yet", async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Friends aren't available yet." }, requestId: "r" }));
    render(<FriendsPanel />);
    expect(await screen.findByText("Friends aren't available yet.")).toBeInTheDocument();
  });
});
