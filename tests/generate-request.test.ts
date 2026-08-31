import { describe, expect, it } from "vitest";

import {
  missingUpstreamMessage,
  parseGenerateBody,
} from "@/lib/generate-request";

describe("parseGenerateBody", () => {
  it("treats an empty body as locked_in (full pack)", () => {
    expect(parseGenerateBody("")).toEqual({ ok: true, kind: "locked_in" });
    expect(parseGenerateBody("   ")).toEqual({ ok: true, kind: "locked_in" });
  });

  it("treats {} as locked_in", () => {
    expect(parseGenerateBody("{}")).toEqual({ ok: true, kind: "locked_in" });
  });

  it("accepts each study kind", () => {
    expect(parseGenerateBody('{"kind":"locked_in"}')).toEqual({
      ok: true,
      kind: "locked_in",
    });
    expect(parseGenerateBody('{"kind":"summary"}')).toEqual({
      ok: true,
      kind: "summary",
    });
    expect(parseGenerateBody('{"kind":"test_me"}')).toEqual({
      ok: true,
      kind: "test_me",
    });
    expect(parseGenerateBody('{"kind":"carded"}')).toEqual({
      ok: true,
      kind: "carded",
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
    expect(parseGenerateBody('{"kind":"locked_in","forceOverwrite":true}')).toEqual({
      ok: true,
      kind: "locked_in",
      forceOverwrite: true,
    });
  });

  it("preserves the protected revision snapshot used by force overwrite CAS", () => {
    expect(parseGenerateBody(JSON.stringify({
      kind: "carded",
      forceOverwrite: true,
      expectedProtected: [
        { key: "view:carded", revision: 4 },
        { key: "card:123", revision: 2 },
      ],
    }))).toEqual({
      ok: true,
      kind: "carded",
      forceOverwrite: true,
      expectedProtected: [
        { key: "view:carded", revision: 4 },
        { key: "card:123", revision: 2 },
      ],
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
