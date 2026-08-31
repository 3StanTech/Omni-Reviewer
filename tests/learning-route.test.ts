import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.hoisted(() => vi.fn());
const getReviewer = vi.hoisted(() => vi.fn());
const updateReviewerExamDate = vi.hoisted(() => vi.fn());
const recordTestAttempts = vi.hoisted(() => vi.fn());
const listTestAttemptStats = vi.hoisted(() => vi.fn());
const reviewCard = vi.hoisted(() => vi.fn());
const serializeCard = vi.hoisted(() => vi.fn((card: unknown) => card));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/queries", () => ({
  getReviewer,
  updateReviewerExamDate,
  recordTestAttempts,
  listTestAttemptStats,
  reviewCard,
  serializeCard,
}));

import { PATCH as examDatePatch } from "@/app/api/reviewers/[id]/exam-date/route";
import { POST as attemptsPost } from "@/app/api/reviewers/[id]/test-attempts/route";
import { POST as reviewPost } from "@/app/api/reviewers/[id]/cards/[cardId]/review/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:3000", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("learning route contracts", () => {
  beforeEach(() => {
    authMock.mockReset();
    getReviewer.mockReset();
    updateReviewerExamDate.mockReset();
    recordTestAttempts.mockReset();
    listTestAttemptStats.mockReset();
    reviewCard.mockReset();
    serializeCard.mockReset();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
  });

  it("rejects impossible exam dates before any write", async () => {
    const response = await examDatePatch(
      jsonRequest({ examDate: "2026-02-29" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(400);
    expect(updateReviewerExamDate).not.toHaveBeenCalled();
  });

  it("records attempts with the authenticated reviewer and expected revision", async () => {
    recordTestAttempts.mockResolvedValue({ stats: [] });
    const response = await attemptsPost(
      jsonRequest({
        expectedRevision: 3,
        answers: [{ itemId: "q1", selectedAnswer: "A" }],
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(200);
    expect(recordTestAttempts).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      userId: "user-1",
      expectedRevision: 3,
      answers: [{ itemId: "q1", selectedAnswer: "A" }],
    });
  });

  it("returns a conflict when a card review loses its revision race", async () => {
    reviewCard.mockResolvedValue({ stale: true });
    const response = await reviewPost(
      jsonRequest({ expectedRevision: 4, rating: "good" }),
      { params: Promise.resolve({ id: "reviewer-1", cardId: "card-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ stale: true });
    expect(reviewCard).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      userId: "user-1",
      cardId: "card-1",
      expectedRevision: 4,
      rating: "good",
    });
  });
});
