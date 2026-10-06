import { afterEach, describe, expect, it } from "vitest";

import { focusActive, readFocusPreference, writeFocusPreference } from "@/components/focus-mode";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function stubWindow(storage: Partial<Storage>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe("focusActive", () => {
  it("is on only when preferred and allowed", () => {
    expect(focusActive(true, true)).toBe(true);
    expect(focusActive(true, false)).toBe(false);
    expect(focusActive(false, true)).toBe(false);
    expect(focusActive(false, false)).toBe(false);
  });
});

describe("focus preference storage", () => {
  it("defaults to off and round-trips through omni-focus", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    expect(readFocusPreference()).toBe(false);
    writeFocusPreference(true);
    expect(storage.getItem("omni-focus")).toBe("on");
    expect(readFocusPreference()).toBe(true);
    writeFocusPreference(false);
    expect(readFocusPreference()).toBe(false);
  });

  it("reads off when storage throws", () => {
    stubWindow({
      getItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    expect(() => writeFocusPreference(true)).not.toThrow();
    expect(readFocusPreference()).toBe(false);
  });

  it("reads off without a window", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(readFocusPreference()).toBe(false);
  });
});
