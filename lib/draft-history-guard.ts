/**
 * Block same-document Back/Forward while a study document draft is dirty.
 *
 * MDN: preventDefault() does not cancel traverse navigations
 * ("cancellation of traverse navigations is not yet implemented").
 * HTML: intercept({ precommitHandler }) may abort before URL/history commit
 * only when the navigate event is cancelable; a rejected precommit promise
 * aborts. precommitHandler on a non-cancelable event throws SecurityError.
 * canIntercept is false for cross-document traverse.
 *
 * Browsers without Navigation API, without precommitHandler, or with
 * !canIntercept / !cancelable cannot abort traverse without a pushState
 * sentinel, and that sentinel truncates Forward. This guard does not use
 * that sentinel. Those environments keep link-click and beforeunload
 * guards only.
 */

export type DraftHistoryIntent = {
  type: "history";
  delta: number;
};

export type DraftNavigateEvent = {
  navigationType: string;
  canIntercept: boolean;
  cancelable: boolean;
  hashChange: boolean;
  downloadRequest: string | null;
  destination: { url: string; index: number };
  signal?: { aborted: boolean; addEventListener: (type: "abort", listener: () => void) => void };
  intercept: (options: {
    precommitHandler?: (controller: unknown) => Promise<void>;
    handler?: () => Promise<void>;
  }) => void;
  preventDefault: () => void;
};

export type DraftNavigation = {
  currentEntry: { index: number; url: string | null };
  addEventListener: (type: "navigate", listener: (event: DraftNavigateEvent) => void) => void;
  removeEventListener: (type: "navigate", listener: (event: DraftNavigateEvent) => void) => void;
};

export type DraftHistoryGuardHost = {
  navigation: DraftNavigation | null;
  supportsPrecommitHandler: boolean;
};

export type DraftHistoryGuard = {
  dispose: () => void;
  confirm: () => void;
  cancel: () => void;
};

export function traverseDelta(fromIndex: number, toIndex: number): number {
  return toIndex - fromIndex;
}

export function canAbortTraverseBeforeCommit(
  event: Pick<DraftNavigateEvent, "canIntercept" | "cancelable" | "intercept">,
  supportsPrecommitHandler: boolean,
): boolean {
  return Boolean(
    supportsPrecommitHandler &&
      event.canIntercept &&
      event.cancelable &&
      typeof event.intercept === "function",
  );
}

export function attachDraftHistoryGuard(
  host: DraftHistoryGuardHost,
  options: {
    isDirty: () => boolean;
    onBlock: (intent: DraftHistoryIntent) => void;
  },
): DraftHistoryGuard {
  let pending: { resolve: () => void; reject: (reason?: unknown) => void } | null = null;

  const settle = (action: "confirm" | "cancel") => {
    const current = pending;
    pending = null;
    if (!current) return;
    if (action === "confirm") current.resolve();
    else current.reject(Object.assign(new Error("The user cancelled the navigation."), { name: "AbortError" }));
  };

  const onNavigate = (event: DraftNavigateEvent) => {
    if (!options.isDirty()) return;
    if (event.hashChange || event.downloadRequest) return;
    if (event.navigationType !== "traverse") return;
    if (!canAbortTraverseBeforeCommit(event, host.supportsPrecommitHandler)) return;
    const currentIndex = host.navigation?.currentEntry.index;
    if (typeof currentIndex !== "number" || currentIndex < 0 || event.destination.index < 0) return;
    const delta = traverseDelta(currentIndex, event.destination.index);
    if (delta === 0) return;
    event.intercept({
      precommitHandler: () =>
        new Promise<void>((resolve, reject) => {
          pending?.reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          pending = { resolve, reject };
          event.signal?.addEventListener("abort", () => {
            if (pending?.reject === reject) settle("cancel");
          });
          options.onBlock({ type: "history", delta });
        }),
    });
  };

  host.navigation?.addEventListener("navigate", onNavigate);

  return {
    dispose() {
      host.navigation?.removeEventListener("navigate", onNavigate);
      settle("cancel");
    },
    confirm() {
      settle("confirm");
    },
    cancel() {
      settle("cancel");
    },
  };
}

export function browserSupportsPrecommitHandler(): boolean {
  return typeof (globalThis as { NavigationPrecommitController?: unknown }).NavigationPrecommitController === "function";
}

export function browserDraftNavigation(): DraftNavigation | null {
  const nav = typeof window === "undefined"
    ? undefined
    : (window as Window & { navigation?: DraftNavigation }).navigation;
  if (!nav || typeof nav.addEventListener !== "function" || !nav.currentEntry) return null;
  return nav;
}
