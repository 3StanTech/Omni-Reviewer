import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("editor compatibility guardrails", () => {
  it("declares the approved React 19 Markdown editor and its source fallback", () => {
    const packageJson = readFileSync(path.join(root, "package.json"), "utf8");
    const editor = readFileSync(path.join(root, "components/study-editor.tsx"), "utf8");
    expect(packageJson).toContain('"@mdxeditor/editor": "4.2.5"');
    expect(editor).toContain("hasLossyRichMarkdown");
    expect(editor).toContain("Source-preserving editor");
    expect(editor).toContain("ssr: false");
  });
});
