import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTimedTestSession,
  verifyTimedTestSession,
} from "@/lib/test-timing";

describe("timed Test Me session claims", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-for-timed-sessions-0123456789";
  });

  it("signs a server-issued deadline and verifies owner/revision claims", () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 4,
      durationSeconds: 300,
      now,
    });
    expect(session.token).not.toContain("test-secret");
    expect(verifyTimedTestSession(session.token, new Date("2026-08-31T00:01:00.000Z"))).toMatchObject({
      ok: true,
      claims: { userId: "user-1", reviewerId: "reviewer-1", viewRevision: 4 },
    });
  });

  it("rejects tampering, early clocks, and expired deadlines", () => {
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 1,
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    const [payload, signature] = session.token.split(".");
    expect(verifyTimedTestSession(`${payload}x.${signature}`, new Date("2026-08-31T00:00:01.000Z"))).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTimedTestSession(session.token, new Date("2026-08-30T23:59:59.000Z"))).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTimedTestSession(session.token, new Date("2026-08-31T00:05:00.000Z"))).toEqual({ ok: false, reason: "expired" });
  });

  it("bounds session duration and token size", () => {
    expect(() => createTimedTestSession({ userId: "u", reviewerId: "r", viewRevision: 1, durationSeconds: 29 })).toThrow();
    expect(verifyTimedTestSession("x".repeat(4097))).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed when the timed-session secret is too short", () => {
    process.env.AUTH_SECRET = "too-short";
    expect(() => createTimedTestSession({
      userId: "u",
      reviewerId: "r",
      viewRevision: 1,
    })).toThrow(/32 bytes/i);
  });
});

describe("Test Me keys and recap contract", () => {
  const root = path.resolve(__dirname, "..");
  const untimed = readFileSync(path.join(root, "components/test-me-view.tsx"), "utf8");
  const timed = readFileSync(path.join(root, "components/timed-test-me.tsx"), "utf8");

  it("guards keys with isStudyKeyTarget and handles 1-4 and Enter in both runners", () => {
    for (const src of [untimed, timed]) {
      expect(src).toContain('import { isStudyKeyTarget } from "@/lib/study-keys";');
      expect(src).toContain("if (!isStudyKeyTarget(event)");
      expect(src).toContain('event.key === "Enter"');
      expect(src).toContain(`event.target.closest("button:not([role='radio'])")?.closest("[data-test-me-sitting]")) return;`);
      expect(src).toContain("data-test-me-sitting>");
      expect(src).not.toContain("if (event.target instanceof HTMLButtonElement");
      expect(src).toContain('if (event.key !== "Enter" || event.nativeEvent.isComposing) return;');
      expect(src).toContain('item.choices ? "1-4 choose · Enter submit · F focus" : "Enter submit · F focus"');
      expect(src).toContain("/^[1-4]$/.test(event.key)");
      expect(src).toContain("void submitAnswer();");
      expect(src).toContain("nextQuestion();");
    }
  });

  it("ends both runners with SittingRecap and its focus section", () => {
    expect(untimed).toContain('<SittingRecap\n          title="Sitting complete"');
    expect(timed).toContain('title="Timed run complete"');
    for (const src of [untimed, timed]) {
      expect(src).toContain("<SittingRecap");
      expect(src).toContain("recapFocusSection(");
      expect(src).toContain("formatSittingDuration(");
      expect(src).toContain("Start again");
    }
    expect(untimed).toContain("Retry missed");
    expect(untimed).toContain("Timed run");
    expect(timed).toContain("Back to study list");
  });

  it("guards timed submits against a double Enter", () => {
    expect(timed).toContain("const inFlight = useRef(false);");
    expect(timed).toContain("inFlight.current) return;");
    expect(timed).toContain("inFlight.current = false;");
  });

  it("omits the study time when the sitting was already complete on load", () => {
    expect(untimed).toContain("useState<number | null>(() => (initialView.finished ? null : Date.now()))");
    expect(untimed).toContain("...(openedAt !== null && finishedAt !== null");
    expect(timed).toContain("...(finishedAt !== null");
    expect(timed).not.toContain("setFinishedAt(nextIndex === -1 ? Date.now()");
  });

  it("shows fine-pointer key hints without em dashes", () => {
    for (const src of [untimed, timed]) {
      expect(src).toContain('className="study-key-hint text-xs text-muted-foreground"');
      expect(src).toContain("1-4 choose · Enter submit · F focus");
      expect(src).toContain("Enter next · F focus");
      expect(src).toContain("@media (pointer: fine)");
      expect(src).not.toContain("\u2014");
    }
  });
});
