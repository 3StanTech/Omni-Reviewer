import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  generationJobs,
  generationJobStatusEnum,
  generationJobStepEnum,
  ingestStatusEnum,
  reviewers,
  sourceKindEnum,
  sources,
  topics,
  users,
  viewKindEnum,
  views,
  cards,
  cardReviews,
  testAttempts,
  testSessions,
  testSessionStatusEnum,
  testSessionModeEnum,
  cardRatingEnum,
  blobReservations,
  blobReservationStateEnum,
  loginThrottles,
  passwordResetTokens,
  annotations,
  annotationViewKindEnum,
} from "@/lib/schema";

describe("schema", () => {
  it("exports users, topics, reviewers, sources, views, and generation_jobs tables", () => {
    expect(users).toBeDefined();
    expect(topics).toBeDefined();
    expect(reviewers).toBeDefined();
    expect(sources).toBeDefined();
    expect(views).toBeDefined();
    expect(generationJobs).toBeDefined();
    expect(cards).toBeDefined();
    expect(testAttempts).toBeDefined();
    expect(testSessions).toBeDefined();
    expect(cardReviews).toBeDefined();
    expect(blobReservations).toBeDefined();

    expect(getTableName(users)).toBe("users");
    expect(getTableName(topics)).toBe("topics");
    expect(getTableName(reviewers)).toBe("reviewers");
    expect(getTableName(sources)).toBe("sources");
    expect(getTableName(views)).toBe("views");
    expect(getTableName(generationJobs)).toBe("generation_jobs");
    expect(getTableName(cards)).toBe("cards");
    expect(getTableName(testAttempts)).toBe("test_attempts");
    expect(getTableName(testSessions)).toBe("test_sessions");
    expect(getTableName(cardReviews)).toBe("card_reviews");
    expect(getTableName(blobReservations)).toBe("blob_reservations");
    expect(getTableName(annotations)).toBe("study_annotations");
    expect(annotations.contentRevision).toBeDefined();
    expect(annotations.archivedAt).toBeDefined();
    expect(getTableName(loginThrottles)).toBe("login_throttles");
    expect(loginThrottles.email).toBeDefined();
    expect(loginThrottles.failedCount).toBeDefined();
    expect(getTableName(passwordResetTokens)).toBe("password_reset_tokens");
    expect(passwordResetTokens.tokenHash).toBeDefined();
    expect(passwordResetTokens.userId).toBeDefined();

    expect(users.email).toBeDefined();
    expect(users.passwordHash).toBeDefined();
    expect(topics.id).toBeDefined();
    expect(topics.userId).toBeDefined();
    expect(topics.deletingAt).toBeDefined();
    expect(reviewers.topicId).toBeDefined();
    expect(reviewers.deletingAt).toBeDefined();
    expect(sources.ingestStatus).toBeDefined();
    expect(sources.deletingAt).toBeDefined();
    expect(sources.blobPathname).toBeDefined();
    expect(blobReservations.pathname).toBeDefined();
    expect(blobReservations.attemptToken).toBeDefined();
    expect(blobReservations.leaseExpiresAt).toBeDefined();
    expect(views.kind).toBeDefined();
    expect(views.modelId).toBeDefined();
    expect(generationJobs.reviewerId).toBeDefined();
    expect(generationJobs.userId).toBeDefined();
    expect(generationJobs.status).toBeDefined();
    expect(generationJobs.step).toBeDefined();
    expect(generationJobs.mode).toBeDefined();
    expect(generationJobs.intent).toBeDefined();
    expect(generationJobs.targetKinds).toBeDefined();
    expect(generationJobs.completedKinds).toBeDefined();
    expect(generationJobs.upstreamRevisions).toBeDefined();
    expect(generationJobs.generationRunId).toBeDefined();
    expect(generationJobs.active).toBeDefined();
    expect(generationJobs.claimToken).toBeDefined();
    expect(generationJobs.claimExpiresAt).toBeDefined();
    expect(generationJobs.expectedProtected).toBeDefined();
    expect(views.generationRunId).toBeDefined();
    expect(views.revision).toBeDefined();
    expect(views.isEdited).toBeDefined();
    expect(views.isPinned).toBeDefined();
    expect(cards.dueAt).toBeDefined();
    expect(cards.revision).toBeDefined();
    expect(testAttempts.correct).toBeDefined();
    expect(testAttempts.sessionId).toBeDefined();
    expect(testSessions.viewRevision).toBeDefined();
    expect(testSessions.expiresAt).toBeDefined();
    expect(testSessions.mode).toBeDefined();
    expect(testSessions.itemIds).toBeDefined();
    expect(testSessions.originSessionId).toBeDefined();
    expect(testSessions.answeredCount).toBeDefined();
    expect(testSessions.status).toBeDefined();
    expect(cardReviews.rating).toBeDefined();
    expect(cardReviews.clientRequestId).toBeDefined();
  });

  it("supports the two-button card ratings", () => {
    expect(cardRatingEnum.enumValues).toEqual(["again", "good"]);
  });

  it("has durable Blob reservation states", () => {
    expect(blobReservationStateEnum.enumValues).toEqual(["reserved", "released", "deleting"]);
  });

  it("has durable timed session states", () => {
    expect(testSessionStatusEnum.enumValues).toEqual(["active", "completed", "expired"]);
  });

  it("distinguishes timed and untimed sittings", () => {
    expect(testSessionModeEnum.enumValues).toEqual(["timed", "untimed"]);
    const config = getTableConfig(testSessions);
    expect(config.indexes.some((index) => index.config.name === "test_sessions_active_owner_mode_unique")).toBe(true);
    expect(config.checks.some((check) => check.name === "test_sessions_timed_requires_deadline")).toBe(true);
    expect(config.indexes.some((index) => index.config.name === "test_sessions_active_owner_unique")).toBe(false);
  });

  it("source kinds include file, paste, and deferred media kinds", () => {
    expect(sourceKindEnum.enumValues).toEqual([
      "pdf",
      "image",
      "text",
      "document",
      "presentation",
      "paste",
      "video",
      "audio",
    ]);
  });

  it("view kinds include the four study views", () => {
    expect(viewKindEnum.enumValues).toEqual([
      "locked_in",
      "summary",
      "test_me",
      "carded",
    ]);
  });

  it("restricts annotations to editable study documents", () => {
    expect(annotationViewKindEnum.enumValues).toEqual(["locked_in", "summary"]);
  });

  it("unprocessed is a valid ingest status", () => {
    expect(ingestStatusEnum.enumValues).toContain("unprocessed");
    expect(ingestStatusEnum.enumValues).toEqual([
      "ready",
      "unprocessed",
      "failed",
    ]);
  });

  it("generation job status and step enums match the pipeline", () => {
    expect(generationJobStatusEnum.enumValues).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "partial",
    ]);
    expect(generationJobStepEnum.enumValues).toEqual([
      "locked_in",
      "summary",
      "test_me",
      "carded",
    ]);
  });
});
