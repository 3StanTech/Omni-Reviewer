import { beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn();
const cleanup = vi.fn();
const destroy = vi.fn(async () => undefined);

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({
    numPages: 3,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 800 * scale, height: 600 * scale }),
      render,
      cleanup,
    }),
    loadingTask: { destroy },
  })),
}));

vi.mock("@/lib/photo-set", () => ({
  VISION_IMAGE_LONG_EDGE: 1600,
  createCanvas: (width: number, height: number) => ({ width, height }),
  releaseCanvas: vi.fn(),
  encodeVisionJpeg: vi.fn(async () => ({ blob: new Blob([new Uint8Array(4)]), width: 1, height: 1 })),
}));

import { renderPdfPages } from "@/lib/pdf-page-images";

describe("renderPdfPages", () => {
  beforeEach(() => {
    render.mockImplementation(() => ({ cancel: vi.fn(), promise: Promise.resolve() }));
  });

  it("renders with the print intent, which pdf.js draws without requestAnimationFrame", async () => {
    const pages: number[] = [];
    for await (const entry of renderPdfPages(new Uint8Array([1]), [1, 3])) pages.push(entry.page);
    expect(pages).toEqual([1, 3]);
    expect(render).toHaveBeenCalledTimes(2);
    for (const [params] of render.mock.calls) {
      // pdf.js sets useRequestAnimationFrame to !(intent is print); a hidden
      // tab pauses requestAnimationFrame, so only "print" keeps rendering.
      expect(params.intent).toBe("print");
      expect(params.canvas).toEqual({ width: 1600, height: 1200 });
      expect(params.annotationMode).toBeUndefined();
    }
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a page outside the file", async () => {
    const run = async () => {
      for await (const _entry of renderPdfPages(new Uint8Array([1]), [4])) void _entry;
    };
    await expect(run()).rejects.toThrow("Page 4 is not in this file.");
    expect(destroy).toHaveBeenCalled();
  });
});
