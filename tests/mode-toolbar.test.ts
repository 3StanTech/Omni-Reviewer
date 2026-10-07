import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ModeActions, ModeToolbarProvider, createModeMenuStore, menuSignature, type ModeMenuItem } from "@/components/mode-toolbar";

const item = (id: string, extra: Partial<ModeMenuItem> = {}): ModeMenuItem => ({ id, label: id, onSelect: () => undefined, ...extra });

describe("mode menu store", () => {
  it("reports a change only when the visible items change", () => {
    const store = createModeMenuStore();
    expect(store.set("doc", [item("pin")])).toBe(true);
    // Same labels with a new handler: no visible change.
    expect(store.set("doc", [item("pin", { onSelect: vi.fn() })])).toBe(false);
    expect(store.set("doc", [item("pin", { label: "Unpin" })])).toBe(true);
    expect(store.set("doc", [item("pin", { label: "Unpin", disabled: true })])).toBe(true);
    expect(store.set("doc", [item("pin", { label: "Unpin", disabled: true, hint: "Protected" })])).toBe(true);
  });

  it("keeps the latest handler for an unchanged menu", () => {
    const store = createModeMenuStore();
    const first = vi.fn();
    const second = vi.fn();
    store.set("doc", [item("check-again", { onSelect: first })]);
    store.set("doc", [item("check-again", { onSelect: second })]);
    store.items()[0].onSelect();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("joins owners and clears an owner on unregister", () => {
    const store = createModeMenuStore();
    store.set("a", [item("one")]);
    store.set("b", [item("two")]);
    expect(store.items().map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(store.set("a", null)).toBe(true);
    expect(store.items().map((entry) => entry.id)).toEqual(["two"]);
    expect(store.set("a", null)).toBe(false);
  });

  it("signs labels, hints and disabled state but not handlers", () => {
    expect(menuSignature([item("x", { onSelect: vi.fn() })])).toBe(menuSignature([item("x")]));
    expect(menuSignature([item("x", { hint: "h" })])).not.toBe(menuSignature([item("x")]));
  });
});

describe("ModeActions", () => {
  it("renders inline outside a strip", () => {
    const html = renderToStaticMarkup(createElement(ModeActions, null, createElement("button", null, "Edit")));
    expect(html).toContain("print-hide");
    expect(html).toContain("Edit");
  });

  it("renders nothing inside a strip until the slot mounts", () => {
    const html = renderToStaticMarkup(
      createElement(ModeToolbarProvider, null, createElement(ModeActions, null, createElement("button", null, "Edit"))),
    );
    expect(html).toBe("");
  });
});
