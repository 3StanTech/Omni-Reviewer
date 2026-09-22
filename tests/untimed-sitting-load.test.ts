import { createElement, Suspense, use, useState, type ReactNode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  sittingLoadForIdentity,
  sittingLoadKey,
  startUntimedSittingLoad,
} from "@/lib/untimed-sitting-load";

const root = path.resolve(__dirname, "..");

function renderHtml(node: ReactNode, timeoutMs = 1_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("render timed out")), timeoutMs);
    const chunks: Buffer[] = [];
    const { pipe } = renderToPipeableStream(node, {
      onAllReady() {
        const writable = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
        writable.on("finish", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        pipe(writable);
      },
      onError(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

describe("untimed sitting load identity", () => {
  it("reuses the current load for the same reviewer and revision", () => {
    const loader = async () => ({ error: "unused" });
    const current = startUntimedSittingLoad("reviewer-1", 2, loader);
    expect(sittingLoadForIdentity(current, "reviewer-1", 2, loader)).toBe(current);
    expect(sittingLoadKey("reviewer-1", 2)).toBe("reviewer-1:2");
  });

  it("replaces an aborted load for the same reviewer instead of reusing it", async () => {
    let started = 0;
    const loader = async (_reviewerId: string, _viewRevision: number, signal?: AbortSignal) => {
      started += 1;
      if (signal?.aborted) return { error: "aborted", aborted: true as const };
      return new Promise<{ error: string; aborted?: boolean }>((resolve) => {
        signal?.addEventListener("abort", () => resolve({ error: "aborted", aborted: true }));
      });
    };
    const aborted = startUntimedSittingLoad("reviewer-1", 2, loader);
    aborted.abort();
    await aborted.promise;
    const replacement = sittingLoadForIdentity(aborted, "reviewer-1", 2, loader);
    expect(replacement).not.toBe(aborted);
    expect(replacement.key).toBe(aborted.key);
    expect(replacement.signal.aborted).toBe(false);
    expect(started).toBe(2);
    replacement.abort();
    await replacement.promise;
  });

  it("starts a replacement and aborts the previous load after a reviewer or revision change", async () => {
    let started = 0;
    let aborted = 0;
    const loader = async (_reviewerId: string, _viewRevision: number, signal?: AbortSignal) => {
      started += 1;
      return new Promise<{ error: string; aborted?: boolean }>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted += 1;
          resolve({ error: "aborted", aborted: true });
        });
      });
    };
    const first = startUntimedSittingLoad("reviewer-1", 2, loader);
    const second = sittingLoadForIdentity(first, "reviewer-2", 2, loader);
    expect(second).not.toBe(first);
    expect(second.key).toBe("reviewer-2:2");
    first.abort();
    await first.promise;
    expect(started).toBe(2);
    expect(aborted).toBe(1);
  });
});

describe("use() promise ownership", () => {
  it("keeps a single fetch when the committed parent holds the promise", async () => {
    let fetches = 0;
    const parentPromise = Promise.resolve("ready").then((value) => {
      fetches += 1;
      return value;
    });

    function Child({ load }: { load: Promise<string> }) {
      return createElement("span", null, use(load));
    }

    function Parent() {
      const [load] = useState(parentPromise);
      return createElement(
        Suspense,
        { fallback: createElement("div", null, "loading") },
        createElement(Child, { load }),
      );
    }

    const html = await renderHtml(createElement(Parent));
    expect(html).toContain("ready");
    expect(fetches).toBe(1);
  });
});

describe("Test Me sitting load wiring", () => {
  const src = readFileSync(path.join(root, "components/test-me-view.tsx"), "utf8");

  it("creates the sitting promise in the committed parent and only reads it in the child", () => {
    expect(src).toContain("sittingLoadForIdentity(sittingLoad, reviewerId, viewRevision)");
    expect(src).toContain("load={sittingLoad.promise}");
    expect(src).toContain("const loaded = use(load)");
    expect(src).not.toContain("useState(() => fetchUntimedSitting");
    expect(src).not.toContain("useState(() => startUntimedSittingLoad");
    expect(src).not.toContain("sittingLoad.abort()");
  });
});
