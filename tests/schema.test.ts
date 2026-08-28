import { getTableName } from "drizzle-orm";
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
} from "@/lib/schema";

describe("schema", () => {
  it("exports users, topics, reviewers, sources, views, and generation_jobs tables", () => {
    expect(users).toBeDefined();
    expect(topics).toBeDefined();
    expect(reviewers).toBeDefined();
    expect(sources).toBeDefined();
    expect(views).toBeDefined();
    expect(generationJobs).toBeDefined();

    expect(getTableName(users)).toBe("users");
    expect(getTableName(topics)).toBe("topics");
    expect(getTableName(reviewers)).toBe("reviewers");
    expect(getTableName(sources)).toBe("sources");
    expect(getTableName(views)).toBe("views");
    expect(getTableName(generationJobs)).toBe("generation_jobs");

    expect(users.email).toBeDefined();
    expect(users.passwordHash).toBeDefined();
    expect(topics.id).toBeDefined();
    expect(topics.userId).toBeDefined();
    expect(reviewers.topicId).toBeDefined();
    expect(sources.ingestStatus).toBeDefined();
    expect(views.kind).toBeDefined();
    expect(views.modelId).toBeDefined();
    expect(generationJobs.reviewerId).toBeDefined();
    expect(generationJobs.userId).toBeDefined();
    expect(generationJobs.status).toBeDefined();
    expect(generationJobs.step).toBeDefined();
  });

  it("source kinds include pdf|image|text|video|audio", () => {
    expect(sourceKindEnum.enumValues).toEqual([
      "pdf",
      "image",
      "text",
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
