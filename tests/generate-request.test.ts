import { describe, expect, it } from "vitest";

import {
  missingUpstreamMessage,
  parseGenerateBody,
} from "@/lib/generate-request";

describe("parseGenerateBody", () => {
  it("maps an empty legacy body to generate_missing", () => {
    expect(parseGenerateBody("")).toEqual({
      ok: true,
      intent: "generate_missing",
      legacy: true,
    });
    expect(parseGenerateBody("   ")).toEqual({
      ok: true,
      intent: "generate_missing",
      legacy: true,
    });
  });

  it("maps {} to generate_missing", () => {
    expect(parseGenerateBody("{}")).toEqual({
      ok: true,
      intent: "generate_missing",
      legacy: true,
    });
  });

  it("accepts explicit generate_missing and redo requests", () => {
    expect(parseGenerateBody('{"intent":"generate_missing"}')).toEqual({
      ok: true,
      intent: "generate_missing",
      legacy: false,
    });
    expect(parseGenerateBody('{"intent":"redo","kind":"locked_in"}')).toEqual({
      ok: true,
      intent: "redo",
      kind: "locked_in",
      scope: "full",
      legacy: false,
    });
    expect(parseGenerateBody('{"intent":"redo","kind":"summary","scope":"selected"}')).toEqual({
      ok: true,
      intent: "redo",
      kind: "summary",
      scope: "selected",
      legacy: false,
    });
  });

  it("maps old kind-only callers without weakening intent", () => {
    expect(parseGenerateBody('{"kind":"summary"}')).toMatchObject({
      ok: true,
      intent: "redo",
      kind: "summary",
      scope: "selected",
      legacy: true,
    });
  });

  it("rejects invalid JSON and unknown kind", () => {
    expect(parseGenerateBody("{")).toEqual({
      ok: false,
      error: "Invalid JSON body",
    });
    expect(parseGenerateBody('{"kind":"quiz"}').ok).toBe(false);
  });

  it("accepts an explicit overwrite confirmation flag", () => {
    expect(parseGenerateBody('{"intent":"redo","kind":"locked_in","forceOverwrite":true}')).toEqual({
      ok: true,
      intent: "redo",
      kind: "locked_in",
      scope: "full",
      forceOverwrite: true,
      legacy: false,
    });
  });

  it("preserves the protected revision snapshot used by force overwrite CAS", () => {
    expect(parseGenerateBody(JSON.stringify({
      intent: "redo",
      kind: "carded",
      forceOverwrite: true,
      expectedProtected: [
        { key: "view:carded", revision: 4 },
        { key: "card:123", revision: 2 },
      ],
    }))).toEqual({
      ok: true,
      intent: "redo",
      kind: "carded",
      scope: "selected",
      forceOverwrite: true,
      expectedProtected: [
        { key: "view:carded", revision: 4 },
        { key: "card:123", revision: 2 },
      ],
      legacy: false,
    });
  });

  it("rejects ambiguous overwrite data on generate_missing", () => {
    expect(parseGenerateBody('{"intent":"generate_missing","forceOverwrite":true}')).toEqual({
      ok: false,
      error: "generate_missing does not accept overwrite confirmation",
    });
  });
});

describe("missingUpstreamMessage", () => {
  it("names Locked In or Summary as the required parent", () => {
    expect(missingUpstreamMessage("summary")).toBe("Generate Locked In first.");
    expect(missingUpstreamMessage("test_me")).toBe("Generate Locked In first.");
    expect(missingUpstreamMessage("carded")).toBe("Generate Summary first.");
  });
});
