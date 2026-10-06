import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isStudyKeyTarget } from "@/lib/study-keys";

// The suite runs in node: stand in for Element and document with minimal stubs.
class FakeElement {
  constructor(private readonly match: string | null) {}
  closest(selector: string) {
    return this.match && selector.includes(this.match) ? this : null;
  }
}

const globals = globalThis as unknown as { Element?: unknown; document?: unknown };
const original = { Element: globals.Element, document: globals.document };
let openDialog: object | null = null;

beforeEach(() => {
  openDialog = null;
  globals.Element = FakeElement;
  globals.document = { querySelector: () => openDialog };
});

afterEach(() => {
  globals.Element = original.Element;
  globals.document = original.document;
});

function key(overrides: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key: "j",
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: new FakeElement(null),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("isStudyKeyTarget", () => {
  it("accepts a plain key on the page", () => {
    expect(isStudyKeyTarget(key())).toBe(true);
  });

  it("accepts shift, which typed characters need", () => {
    expect(isStudyKeyTarget(key({ shiftKey: true }))).toBe(true);
  });

  it.each([
    ["an input", "input"],
    ["a contenteditable", "[contenteditable='true']"],
    ["the Ask panel", "[data-ask-panel]"],
  ])("ignores keys typed in %s", (_, match) => {
    expect(isStudyKeyTarget(key({ target: new FakeElement(match) }))).toBe(false);
  });

  it("ignores keys while a dialog is open", () => {
    openDialog = {};
    expect(isStudyKeyTarget(key())).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "altKey"])("ignores %s chords", (modifier) => {
    expect(isStudyKeyTarget(key({ [modifier]: true }))).toBe(false);
  });

  it.each(["repeat", "isComposing", "defaultPrevented"])("ignores %s events", (flag) => {
    expect(isStudyKeyTarget(key({ [flag]: true }))).toBe(false);
  });

  it("accepts a non-element target", () => {
    expect(isStudyKeyTarget(key({ target: null }))).toBe(true);
  });
});
