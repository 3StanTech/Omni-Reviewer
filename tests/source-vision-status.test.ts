import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VisionStatus } from "@/components/source-panel";
import type { VisionProgress } from "@/lib/use-source-vision";

function render(progress: VisionProgress | undefined): string {
  return renderToStaticMarkup(createElement(VisionStatus, { progress, onRetry: () => undefined }));
}

describe("VisionStatus", () => {
  it("shows refused pages on the row once reading is done", () => {
    const html = render({ state: "done", done: 8, total: 8, unreadable: [6] });
    expect(html).toContain("Page 6 could not be read.");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("Try again");
  });

  it("lists several refused pages in order", () => {
    const html = render({ state: "done", done: 8, total: 8, unreadable: [9, 3, 6] });
    expect(html).toContain("Pages 3, 6 and 9 could not be read.");
  });

  it("adds nothing for a finished read with no refused pages", () => {
    expect(render({ state: "done", done: 8, total: 8 })).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("keeps the failure message and Try again, with refused pages beneath", () => {
    const html = render({ state: "stopped", done: 3, total: 8, message: "Reading stopped.", unreadable: [2] });
    expect(html).toContain("Reading stopped.");
    expect(html).toContain("Try again");
    expect(html).toContain("Page 2 could not be read.");
  });

  it("shows only progress while reading", () => {
    const html = render({ state: "reading", done: 2, total: 8, unreadable: [2] });
    expect(html).toContain("Reading slide images: 2 of 8");
    expect(html).not.toContain("could not be read");
  });
});
