import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("Carded finite session UI", () => {
  const src = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
  const reviewRoute = readFileSync(path.join(root, "app/api/reviewers/[id]/cards/[cardId]/review/route.ts"), "utf8");
  const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");

  it("captures a due queue and shows completed/total with Browse all", () => {
    expect(src).toContain("useState<CapturedCard[]>(() => captureDueQueue(durableCards, Date.now()))");
    expect(src).toContain("captureDueQueue");
    expect(src).toContain("reconcileDueSession");
    expect(src).toContain("Browse all");
    expect(src).toContain("No cards due");
    expect(src).toContain("Session complete");
    expect(src).toContain("${dueSession.completed} of ${dueSession.total}");
  });

  it("rates only after a successful save and keeps the same client request on retry", () => {
    expect(src).toContain("clientRequestId: requestId");
    expect(src).toContain("if (epoch !== reviewEpoch.current) return");
    expect(src).toContain("setRatedIds");
    expect(src).toContain("requestIds.current.get(card.id)");
    expect(reviewRoute).toContain("clientRequestId");
    expect(queries).toContain("ON CONFLICT (card_id, client_request_id)");
  });

  it("does not schedule from Browse all navigation", () => {
    expect(src).toContain('mode === "browse"');
    expect(src).toContain("if (browsing || !card || !isDurableCard(card) || busy || dueStale) return");
    expect(src).toContain("{!browsing && isDurableCard(card) && flipped && !dueStale");
  });
});

describe("untimed Test Me sitting UI", () => {
  const src = readFileSync(path.join(root, "components/test-me-view.tsx"), "utf8");

  it("resumes from the practice-session route and keeps Retry missed distinct from Start again", () => {
    expect(src).toContain("sittingLoadForIdentity");
    expect(src).toContain("load={sittingLoad.promise}");
    expect(src).toContain("const loaded = use(load)");
    expect(src).toContain("/practice-session");
    expect(src).toContain('mutateSession("retry_missed")');
    expect(src).toContain('mutateSession("start_again")');
    expect(src).toContain("Retry missed");
    expect(src).toContain("Start again");
    expect(src).toContain('mode: "untimed"');
    expect(src).toContain("Timed run");
  });
});

describe("untimed sitting SQL contracts", () => {
  const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");
  const schema = readFileSync(path.join(root, "lib/schema.ts"), "utf8");

  it("scopes one active sitting per owner/reviewer/mode and keeps timed deadlines", () => {
    expect(schema).toContain("test_sessions_active_owner_mode_unique");
    expect(schema).toContain("test_sessions_timed_requires_deadline");
    expect(queries).toContain("ON CONFLICT (user_id, reviewer_id, mode)");
    expect(queries).toContain("'timed'::test_session_mode");
    expect(queries).toContain("'untimed'::test_session_mode");
    expect(queries).toContain("expires_at IS NULL");
  });

  it("advances untimed progress only for newly inserted answers against the snapshot", () => {
    expect(queries).toContain("jsonb_array_length(ts.item_ids)");
    expect(queries).toContain("AND EXISTS (SELECT 1 FROM written AS w WHERE w.inserted)");
    expect(queries).toContain("ts.item_ids @>");
  });

  it("replaces an active untimed sitting in the same statement as insert", () => {
    expect(queries).toContain("AND mode = 'untimed'::test_session_mode");
    expect(queries).toContain("replaceActive");
    expect(queries).toContain("replaceActive: true");
    expect(queries).not.toContain("await expireActiveUntimedSession");
    const insertFn = queries.slice(
      queries.indexOf("async function insertUntimedPracticeSession"),
      queries.indexOf("export async function createOrResumeUntimedPracticeSession"),
    );
    expect(insertFn).toContain("AND mode = 'untimed'::test_session_mode");
    expect(insertFn).toContain("ON CONFLICT (user_id, reviewer_id, mode)");
    const attemptFn = queries.slice(
      queries.indexOf("export async function recordUntimedTestAttempt"),
      queries.indexOf("export async function updateStudyView"),
    );
    const revisionStaleAt = attemptFn.indexOf("AND ts.view_revision <>");
    const invalidAt = attemptFn.indexOf("THEN 'invalid'");
    expect(revisionStaleAt).toBeGreaterThan(-1);
    expect(invalidAt).toBeGreaterThan(revisionStaleAt);
    expect(attemptFn).toContain('row?.outcome === "stale"');
  });
});
