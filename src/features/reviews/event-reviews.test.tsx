import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventReviews as Data, ReviewEligibility } from "@/contracts/reviews";
import { EventReviews } from "./event-reviews";

const EVENT = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const review = {
  id: "r1",
  eventId: EVENT,
  author: { id: "alice", displayName: "Alice" },
  rating: 4,
  body: "Great sound",
  createdAt: "2026-12-02T10:00:00.000Z",
  editedAt: null,
};
const data = (viewer: ReviewEligibility, reviews = [review]): Data => ({
  eventId: EVENT,
  reviews,
  count: reviews.length,
  averageRating: reviews.length ? 4 : null,
  viewer,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("EventReviews", () => {
  it("shows reviews, the average and an empty state", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: data({ status: "NOT_SIGNED_IN" }) }));
    const { unmount } = render(<EventReviews eventId={EVENT} />);
    expect(await screen.findByText("Great sound")).toBeInTheDocument();
    expect(screen.getByText("4 out of 5 from 1 attendee.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "4 out of 5" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/onboarding");
    unmount();

    fetchMock.mockResolvedValueOnce(json(200, { data: data({ status: "NOT_ATTENDED" }, []) }));
    render(<EventReviews eventId={EVENT} />);
    expect(await screen.findByText("No reviews yet.")).toBeInTheDocument();
    expect(screen.getByText(/once you've been checked in/)).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("lets an attendee post a review and refreshes", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: data({ status: "CAN_REVIEW" }, []) }))
      .mockResolvedValueOnce(json(201, { data: review }))
      .mockResolvedValueOnce(json(200, { data: data({ status: "ALREADY_REVIEWED", reviewId: "r1" }) }));
    render(<EventReviews eventId={EVENT} />);

    const post = await screen.findByRole("button", { name: "Post review" });
    await user.click(post);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a rating");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText("4 stars"));
    await user.type(screen.getByLabelText("Comments (optional)"), "Great sound");
    await user.click(post);
    expect(await screen.findByRole("button", { name: "Update review" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`/api/events/${EVENT}/reviews`);
    expect(JSON.parse(init.body)).toEqual({ rating: 4, body: "Great sound" });
  });

  it("edits an existing review with PATCH, prefilled", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: data({ status: "ALREADY_REVIEWED", reviewId: "r1" }) }))
      .mockResolvedValueOnce(json(200, { data: { ...review, rating: 5 } }))
      .mockResolvedValueOnce(json(200, { data: data({ status: "ALREADY_REVIEWED", reviewId: "r1" }) }));
    render(<EventReviews eventId={EVENT} />);
    expect(await screen.findByLabelText("Comments (optional)")).toHaveValue("Great sound");
    expect(screen.getByLabelText("4 stars")).toBeChecked();
    await user.click(screen.getByLabelText("5 stars"));
    await user.click(screen.getByRole("button", { name: "Update review" }));
    expect(await screen.findByText("Review updated.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]![0]).toBe(`/api/events/${EVENT}/reviews/mine`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("PATCH");
  });

  it("explains a hidden own review instead of offering a second post", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: data({ status: "ALREADY_REVIEWED", reviewId: "gone" }) }));
    render(<EventReviews eventId={EVENT} />);
    expect(await screen.findByText("Your review has been hidden by moderation.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/ })).not.toBeInTheDocument();
  });

  it("lets a signed-in viewer report someone else's review", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { data: data({ status: "NOT_ATTENDED" }) }))
      .mockResolvedValueOnce(json(201, { data: { id: "rep1", status: "OPEN", alreadyReported: false } }));
    render(<EventReviews eventId={EVENT} />);
    await user.click(await screen.findByRole("button", { name: "Report" }));
    await user.selectOptions(screen.getByLabelText("Why are you reporting this?"), "ABUSE");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText(/^Reported/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/reports");
    expect(JSON.parse(init.body)).toEqual({ targetType: "REVIEW", targetId: "r1", reason: "ABUSE", details: "" });
  });

  it("shows the server's message when reviews are unavailable", async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Reviews aren't available yet." } }));
    render(<EventReviews eventId={EVENT} />);
    expect(await screen.findByText("Reviews aren't available yet.")).toBeInTheDocument();
  });
});
