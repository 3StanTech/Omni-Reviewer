import { describe, expect, it } from "vitest";

import {
  attachDraftHistoryGuard,
  canAbortTraverseBeforeCommit,
  traverseDelta,
  type DraftHistoryGuardHost,
  type DraftNavigateEvent,
  type DraftNavigation,
} from "@/lib/draft-history-guard";

type Entry = { url: string };

function createSession(urls: string[], index: number) {
  const entries: Entry[] = urls.map((url) => ({ url }));
  let current = index;
  const navListeners: Array<(event: DraftNavigateEvent) => void> = [];
  let canIntercept = true;
  let cancelable = true;
  let preventDefaultCanceled = false;

  async function traverse(delta: number): Promise<void> {
    const next = current + delta;
    if (next < 0 || next >= entries.length || next === current) return;
    const captured: {
      options: {
        precommitHandler?: (controller: unknown) => Promise<void>;
        handler?: () => Promise<void>;
      } | null;
    } = { options: null };
    const event: DraftNavigateEvent = {
      navigationType: "traverse",
      canIntercept,
      cancelable,
      hashChange: false,
      downloadRequest: null,
      destination: { url: entries[next].url, index: next },
      intercept(options) {
        if (!canIntercept) throw new Error("SecurityError");
        if (options.precommitHandler && !cancelable) throw new Error("SecurityError");
        captured.options = options;
      },
      preventDefault() {
        // MDN: cancellation of traverse navigations is not yet implemented.
        preventDefaultCanceled = true;
      },
    };
    for (const listener of navListeners) listener(event);
    const intercepted = captured.options;
    if (intercepted?.precommitHandler) {
      try {
        await intercepted.precommitHandler({});
        current = next;
      } catch {
        // Rejected precommit aborts before URL/history commit.
      }
      return;
    }
    current = next;
  }

  const navigation: DraftNavigation = {
    get currentEntry() {
      return { index: current, url: entries[current]?.url ?? null };
    },
    addEventListener(_type: "navigate", listener: (event: DraftNavigateEvent) => void) {
      navListeners.push(listener);
    },
    removeEventListener(_type: "navigate", listener: (event: DraftNavigateEvent) => void) {
      const at = navListeners.indexOf(listener);
      if (at >= 0) navListeners.splice(at, 1);
    },
  };

  function host(useNavigation: boolean, supportsPrecommitHandler: boolean): DraftHistoryGuardHost {
    return {
      navigation: useNavigation ? navigation : null,
      supportsPrecommitHandler,
    };
  }

  return {
    host,
    setInterceptable(next: { canIntercept: boolean; cancelable: boolean }) {
      canIntercept = next.canIntercept;
      cancelable = next.cancelable;
    },
    snapshot() {
      return {
        url: entries[current].url,
        index: current,
        urls: entries.map((entry) => entry.url),
        canGoForward: current < entries.length - 1,
        preventDefaultCanceled,
      };
    },
    back() {
      return traverse(-1);
    },
    forward() {
      return traverse(1);
    },
  };
}

describe("draft history guard", () => {
  it("only aborts traverse before commit when intercept, cancelable, and precommitHandler are available", () => {
    const intercept = () => {};
    expect(canAbortTraverseBeforeCommit({ canIntercept: true, cancelable: true, intercept }, true)).toBe(true);
    expect(canAbortTraverseBeforeCommit({ canIntercept: true, cancelable: true, intercept }, false)).toBe(false);
    expect(canAbortTraverseBeforeCommit({ canIntercept: false, cancelable: true, intercept }, true)).toBe(false);
    expect(canAbortTraverseBeforeCommit({ canIntercept: true, cancelable: false, intercept }, true)).toBe(false);
    expect(traverseDelta(1, 0)).toBe(-1);
    expect(traverseDelta(1, 2)).toBe(1);
  });

  it("Save after Back commits the original traverse once precommitHandler resolves", async () => {
    const session = createSession(["https://app.local/topics", "https://app.local/study"], 1);
    const guard = attachDraftHistoryGuard(session.host(true, true), {
      isDirty: () => true,
      onBlock: () => {
        queueMicrotask(() => guard.confirm());
      },
    });
    await session.back();
    expect(session.snapshot().url).toBe("https://app.local/topics");
  });

  it("Cancel after Back rejects precommitHandler, stays on the document, and keeps Forward", async () => {
    const session = createSession(
      ["https://app.local/topics", "https://app.local/study", "https://app.local/later"],
      1,
    );
    const guard = attachDraftHistoryGuard(session.host(true, true), {
      isDirty: () => true,
      onBlock: () => {
        queueMicrotask(() => guard.cancel());
      },
    });
    await session.back();
    expect(session.snapshot().url).toBe("https://app.local/study");
    expect(session.snapshot().canGoForward).toBe(true);
    expect(session.snapshot().urls).toEqual([
      "https://app.local/topics",
      "https://app.local/study",
      "https://app.local/later",
    ]);
  });

  it("Save after Forward from a Back-entry document commits that Forward traverse", async () => {
    const session = createSession(
      ["https://app.local/topics", "https://app.local/study", "https://app.local/later"],
      1,
    );
    const guard = attachDraftHistoryGuard(session.host(true, true), {
      isDirty: () => true,
      onBlock: () => {
        queueMicrotask(() => guard.confirm());
      },
    });
    await session.forward();
    expect(session.snapshot().url).toBe("https://app.local/later");
    expect(session.snapshot().urls).toHaveLength(3);
  });

  it("does not call preventDefault to stop a traverse", async () => {
    const session = createSession(["https://app.local/topics", "https://app.local/study"], 1);
    const guard = attachDraftHistoryGuard(session.host(true, true), {
      isDirty: () => true,
      onBlock: () => {
        queueMicrotask(() => guard.cancel());
      },
    });
    await session.back();
    expect(session.snapshot().preventDefaultCanceled).toBe(false);
    expect(session.snapshot().url).toBe("https://app.local/study");
  });

  it("lets traverse proceed when canIntercept or cancelable is false", async () => {
    const session = createSession(
      ["https://app.local/topics", "https://app.local/study", "https://app.local/later"],
      1,
    );
    let blocked = false;
    attachDraftHistoryGuard(session.host(true, true), {
      isDirty: () => true,
      onBlock: () => {
        blocked = true;
      },
    });
    session.setInterceptable({ canIntercept: false, cancelable: true });
    await session.back();
    expect(blocked).toBe(false);
    expect(session.snapshot().url).toBe("https://app.local/topics");
  });

  it("does not push a sentinel when Navigation API is missing, so Forward is not truncated", async () => {
    const session = createSession(
      ["https://app.local/topics", "https://app.local/study", "https://app.local/later"],
      1,
    );
    let blocked = false;
    attachDraftHistoryGuard(session.host(false, false), {
      isDirty: () => true,
      onBlock: () => {
        blocked = true;
      },
    });
    expect(session.snapshot().canGoForward).toBe(true);
    await session.back();
    expect(blocked).toBe(false);
    expect(session.snapshot().url).toBe("https://app.local/topics");
  });
});
