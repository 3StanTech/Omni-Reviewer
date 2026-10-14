"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { LOOK_THEME_COLOR } from "@/lib/look-theme";
import { readLocalStorage, writeLocalStorage } from "@/lib/safe-storage";

export type LookId = "dreamland" | "day" | "night";

export const LOOK_IDS: LookId[] = ["dreamland", "day", "night"];

export const DEFAULT_LOOK: LookId = "dreamland";
export const LOOK_STORAGE_KEY = "omni-look";

const LOOK_CHANGE_EVENT = "omni-look-change";

type LookContextValue = {
  look: LookId;
  setLook: (look: LookId) => void;
};

const LookContext = createContext<LookContextValue | null>(null);

export function isLookId(value: unknown): value is LookId {
  return typeof value === "string" && LOOK_IDS.includes(value as LookId);
}

/** Legacy Thea/RemNote preferences keep their user on the light layout. */
export function normalizeLook(value: unknown): LookId {
  if (isLookId(value)) return value;
  if (value === "thea" || value === "remnote") return "day";
  return DEFAULT_LOOK;
}

export function applyLookToDocument(look: LookId) {
  const root = document.documentElement;
  root.dataset.look = look;
  root.classList.toggle("dark", look === "night");
  // The browser bar follows the mood, not the OS scheme.
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", LOOK_THEME_COLOR[look]));
}

function readStoredLook(): LookId {
  return normalizeLook(readLocalStorage(LOOK_STORAGE_KEY));
}

function subscribeLook(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(LOOK_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(LOOK_CHANGE_EVENT, onStoreChange);
  };
}

export function LookProvider({ children }: { children: ReactNode }) {
  const look = useSyncExternalStore(
    subscribeLook,
    readStoredLook,
    () => DEFAULT_LOOK,
  );

  useLayoutEffect(() => {
    applyLookToDocument(look);
    // Navigation can re-insert the server's theme-color meta; keep it on the mood.
    const color = LOOK_THEME_COLOR[look];
    const observer = new MutationObserver(() => {
      document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
        if (meta.getAttribute("content") !== color) meta.setAttribute("content", color);
      });
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["content"],
    });
    return () => observer.disconnect();
  }, [look]);

  const setLook = useCallback((next: LookId) => {
    writeLocalStorage(LOOK_STORAGE_KEY, next);
    applyLookToDocument(next);
    window.dispatchEvent(new Event(LOOK_CHANGE_EVENT));
  }, []);

  const value = useMemo(() => ({ look, setLook }), [look, setLook]);

  return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}

export function useLook(): LookId {
  const context = useContext(LookContext);
  if (!context) {
    throw new Error("useLook must be used within LookProvider");
  }
  return context.look;
}

export function useSetLook(): (look: LookId) => void {
  const context = useContext(LookContext);
  if (!context) {
    throw new Error("useSetLook must be used within LookProvider");
  }
  return context.setLook;
}
