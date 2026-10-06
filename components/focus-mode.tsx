"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CornersIn, CornersOut } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { readLocalStorage, writeLocalStorage } from "@/lib/safe-storage";
import { isStudyKeyTarget } from "@/lib/study-keys";

export const FOCUS_STORAGE_KEY = "omni-focus";
const FOCUS_CHANGE_EVENT = "omni-focus-change";

/** Focus hides the chrome only where the active mode allows it. */
export function focusActive(preferred: boolean, allowed: boolean): boolean {
  return preferred && allowed;
}

export function readFocusPreference(): boolean {
  return readLocalStorage(FOCUS_STORAGE_KEY) === "on";
}

export function writeFocusPreference(on: boolean) {
  writeLocalStorage(FOCUS_STORAGE_KEY, on ? "on" : "off");
}

function subscribeFocus(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(FOCUS_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(FOCUS_CHANGE_EVENT, onStoreChange);
  };
}

function dialogOpen(): boolean {
  return Boolean(document.querySelector("[role='dialog']:not([hidden]), dialog[open]"));
}

type FocusModeContextValue = {
  active: boolean;
  allowed: boolean;
  setAllowed: (allowed: boolean) => void;
  toggle: () => void;
  exit: () => void;
};

const noop = () => undefined;
const INACTIVE: FocusModeContextValue = {
  active: false,
  allowed: false,
  setAllowed: noop,
  toggle: noop,
  exit: noop,
};

const FocusModeContext = createContext<FocusModeContextValue>(INACTIVE);

export function FocusModeProvider({ children }: { children: ReactNode }) {
  const preferred = useSyncExternalStore(subscribeFocus, readFocusPreference, () => false);
  const [allowed, setAllowed] = useState(false);
  const active = focusActive(preferred, allowed);

  const setPreferred = useCallback((on: boolean) => {
    writeFocusPreference(on);
    window.dispatchEvent(new Event(FOCUS_CHANGE_EVENT));
  }, []);
  const toggle = useCallback(() => setPreferred(!readFocusPreference()), [setPreferred]);
  const exit = useCallback(() => setPreferred(false), [setPreferred]);

  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    if (active) {
      root.dataset.focus = "on";
      // The control that had focus may now be hidden; keep focus on the toggle.
      frame = requestAnimationFrame(() => {
        if (document.activeElement?.closest("[data-focus-hide]")) {
          document.querySelector<HTMLElement>("[data-focus-toggle]")?.focus();
        }
      });
    } else {
      delete root.dataset.focus;
    }
    return () => {
      cancelAnimationFrame(frame);
      delete root.dataset.focus;
    };
  }, [active]);

  useEffect(() => {
    if (!allowed) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "f" || event.key === "F") {
        if (!isStudyKeyTarget(event)) return;
        event.preventDefault();
        toggle();
        return;
      }
      if (event.key === "Escape" && active && !event.defaultPrevented && !dialogOpen()) {
        event.preventDefault();
        exit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, allowed, exit, toggle]);

  const value = useMemo(
    () => ({ active, allowed, setAllowed, toggle, exit }),
    [active, allowed, toggle, exit],
  );

  return <FocusModeContext.Provider value={value}>{children}</FocusModeContext.Provider>;
}

/** Outside a provider this returns an inert value, so callers never need a guard. */
export function useFocusMode(): FocusModeContextValue {
  return useContext(FocusModeContext);
}

export function FocusToggle() {
  const { active, allowed, toggle } = useFocusMode();
  if (!allowed) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-focus-toggle
      aria-pressed={active}
      title={active ? "Exit focus (Esc)" : "Focus (F)"}
      onClick={toggle}
    >
      {active ? <CornersIn weight="bold" /> : <CornersOut weight="bold" />}
      Focus
    </Button>
  );
}
