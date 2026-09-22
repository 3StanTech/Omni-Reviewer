import { describe, expect, it } from "vitest";

import { getLocalStorage, readLocalStorage, removeLocalStorage, writeLocalStorage } from "@/lib/safe-storage";

describe("blocked browser storage", () => {
  it("fails closed when the localStorage getter is blocked", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage(): Storage {
          throw new DOMException("Access denied", "SecurityError");
        },
      },
    });
    try {
      expect(getLocalStorage()).toBeNull();
      expect(readLocalStorage("look")).toBeNull();
      expect(writeLocalStorage("look", "night")).toBe(false);
      expect(removeLocalStorage("look")).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
