"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * The pack page's sticky strip holds the mode tabs, the active mode's tools and
 * one More menu. Tools keep their state in the mode that owns them: they render
 * into the strip through `ModeActions` (a portal into the slot `ViewTabs` owns),
 * and register their More items as data with `useModeMenuItems`, so `ViewTabs`
 * renders them as real menu items with the shared menu's keyboard handling.
 */

export type ModeMenuItem = {
  /** Stable per item, e.g. "pin", "earlier", "check-again", "open-slides". */
  id: string;
  label: string;
  /** Muted second line. */
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
};

/** What a menu shows; handlers are left out so a new handler alone never re-renders the menu. */
export function menuSignature(items: readonly ModeMenuItem[]): string {
  return items.map((item) => `${item.id}\u0000${item.label}\u0000${item.hint ?? ""}\u0000${item.disabled ? 1 : 0}`).join("\u0001");
}

/**
 * Registered items per owner. `set` keeps the latest handlers every call and
 * reports whether the visible menu changed, so callers bump state only then.
 */
export function createModeMenuStore() {
  const owners = new Map<string, ModeMenuItem[]>();
  let signature = "";
  function items(): ModeMenuItem[] {
    return [...owners.values()].flat();
  }
  return {
    set(owner: string, next: ModeMenuItem[] | null): boolean {
      if (next === null || next.length === 0) owners.delete(owner);
      else owners.set(owner, next);
      const nextSignature = menuSignature(items());
      const changed = nextSignature !== signature;
      signature = nextSignature;
      return changed;
    },
    items,
  };
}

type ModeMenuStore = ReturnType<typeof createModeMenuStore>;

type ModeToolbarValue = {
  actionsSlot: HTMLElement | null;
  setActionsSlot: (element: HTMLElement | null) => void;
  store: ModeMenuStore;
  /** Bumped only when the visible menu changes. */
  version: number;
  bump: () => void;
};

const ModeToolbarContext = createContext<ModeToolbarValue | null>(null);

export function ModeToolbarProvider({ children }: { children: ReactNode }) {
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [store] = useState(createModeMenuStore);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  const value = useMemo(
    () => ({ actionsSlot, setActionsSlot, store, version, bump }),
    [actionsSlot, store, version, bump],
  );
  return <ModeToolbarContext.Provider value={value}>{children}</ModeToolbarContext.Provider>;
}

/** Callback ref for the strip element the active mode's tools render into. */
export function useModeToolbarSlotRef(): (element: HTMLElement | null) => void {
  const value = useContext(ModeToolbarContext);
  return value?.setActionsSlot ?? noopRef;
}

function noopRef() {}

/**
 * Renders the mode's tools into the strip. Until the slot mounts it renders
 * nothing, so the tools never flash in the document flow. Outside a provider
 * (a page without the strip) they render inline.
 */
export function ModeActions({ children }: { children: ReactNode }) {
  const value = useContext(ModeToolbarContext);
  if (!value) {
    return <div className="print-hide flex flex-wrap items-center gap-1">{children}</div>;
  }
  return value.actionsSlot ? createPortal(children, value.actionsSlot) : null;
}

/**
 * Registers this owner's More items while mounted. Handlers stay current on
 * every render; the menu re-renders only when labels, hints or disabled states
 * change.
 */
export function useModeMenuItems(owner: string, items: ModeMenuItem[]) {
  const value = useContext(ModeToolbarContext);
  const store = value?.store;
  const bump = value?.bump;
  const itemsRef = useRef(items);
  const signature = menuSignature(items);

  // Keep the latest handlers; the registered items call through this ref.
  useEffect(() => {
    itemsRef.current = items;
  });

  useEffect(() => {
    if (!store || !bump) return;
    const registered = itemsRef.current.map((item, index) => ({
      ...item,
      onSelect: () => itemsRef.current[index]?.onSelect(),
    }));
    if (store.set(owner, registered)) bump();
  }, [owner, signature, store, bump]);

  useEffect(() => {
    if (!store || !bump) return;
    return () => {
      if (store.set(owner, null)) bump();
    };
  }, [owner, store, bump]);
}

/** The registered items of the active mode, for the More menu. */
export function useModeMenuItemsValue(): ModeMenuItem[] {
  // The context value changes with `version`, so readers re-render exactly when the visible items change.
  const value = useContext(ModeToolbarContext);
  return value ? value.store.items() : [];
}
