import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("annotation persistence boundaries", () => {
  it("validates owner, all three revisions and canonical quotes before save", () => {
    const route = read("app/api/reviewers/[id]/annotations/route.ts");
    const viewRoute = read("app/api/reviewers/[id]/views/[kind]/route.ts");
    const query = read("lib/queries.ts");
    expect(route).toContain("getReviewer(reviewerId, userId)");
    expect(route).toContain("expectedContentRevision");
    expect(route).toContain("validateAnnotationBatch(view.content, parsed.data.annotations)");
    expect(route).toContain("listAnnotationPageForReviewer");
    expect(route).toContain("status: 409");
    expect(query).toContain("FOR UPDATE OF v");
    expect(query).toContain("annotationSaveRows(args.items)");
    expect(query).toContain("annotationRemapRows(annotationMappings)");
    expect(query).toContain("ROWS FROM(");
    expect(query).toContain("WITH ORDINALITY AS item(");
    expect(query).toContain("item.ordinality");
    expect(query).toContain("annotation_revision = v.annotation_revision + 1");
    expect(query).toContain("study_annotations");
    expect(query).toContain("${args.kind}::annotation_view_kind");
    expect(query).toContain("activeOnly: true");
    expect(viewRoute).toContain("loadGenerationViews");
    expect(viewRoute).toContain("staleKinds: viewsPayload.staleKinds ?? []");
  });

  it("archives displaced annotations rather than guessing a new occurrence", () => {
    const query = read("lib/queries.ts");
    expect(query).toContain("archive_reason = CASE");
    expect(query).toContain("content_changed");
    expect(query).toContain("input_mappings");
    expect(query).toContain("remapAnnotation");
    expect(query).toContain("CROSS JOIN updated_view");
  });

  it("keeps annotation-only saves from marking derived modes stale", () => {
    const tabs = read("components/view-tabs.tsx");
    expect(tabs).toContain("staleKinds: next.staleKinds ?? views.staleKinds");
    expect(tabs).not.toContain('staleKinds: contentChanged ? ["carded"]');
  });
});
