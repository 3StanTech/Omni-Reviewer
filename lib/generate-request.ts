import { z } from "zod";

import {
  GENERATION_KINDS,
  type GenerateKind,
  type GenerationIntent,
  type GenerationRequest,
  type GenerationScope,
} from "@/lib/generation-plan";

export {
  GENERATION_KINDS,
  type ExpectedProtectedRevision,
  type GenerateKind,
  type GenerationIntent,
  type GenerationRequest,
  type GenerationScope,
} from "@/lib/generation-plan";

const bodySchema = z.object({
  intent: z.enum(["generate_missing", "redo"]).optional(),
  kind: z.enum(GENERATION_KINDS).optional(),
  scope: z.enum(["selected", "full"]).optional(),
  forceOverwrite: z.boolean().optional(),
  expectedProtected: z.array(z.object({
    key: z.string().min(1).max(300),
    revision: z.number().int().positive(),
  }).strict()).max(500).optional(),
}).strict();

export function parseGenerateBody(
  raw: string,
): ({ ok: true } & GenerationRequest & { legacy: boolean }) | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, intent: "generate_missing", legacy: true };
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: "intent must be generate_missing or redo; kind must be locked_in, summary, test_me, or carded",
    };
  }

  const value = parsed.data;
  const legacy = value.intent === undefined;
  let intent: GenerationIntent;
  const kind: GenerateKind | undefined = value.kind;
  let scope: GenerationScope | undefined = value.scope;

  if (value.intent === "generate_missing") {
    if (value.kind !== undefined || value.scope !== undefined) {
      return { ok: false, error: "generate_missing does not accept kind or scope" };
    }
    if (value.forceOverwrite !== undefined || value.expectedProtected !== undefined) {
      return { ok: false, error: "generate_missing does not accept overwrite confirmation" };
    }
    intent = "generate_missing";
  } else if (value.intent === "redo") {
    if (!value.kind) return { ok: false, error: "redo requires a study mode kind" };
    intent = "redo";
    scope = scope ?? (value.kind === "locked_in" ? "full" : "selected");
  } else if (!value.kind) {
    // Empty and `{}` requests from the previous client mean "fill the pack".
    intent = "generate_missing";
  } else {
    // Preserve old direct callers: kind-only Locked In was the whole-pack
    // operation, while the other kinds were selected-mode redos.
    intent = "redo";
    scope = scope ?? (value.kind === "locked_in" ? "full" : "selected");
  }

  return {
    ok: true,
    intent,
    ...(kind ? { kind } : {}),
    ...(scope ? { scope } : {}),
    ...(value.forceOverwrite !== undefined ? { forceOverwrite: value.forceOverwrite } : {}),
    ...(value.expectedProtected !== undefined ? { expectedProtected: value.expectedProtected } : {}),
    legacy,
  };
}

export function missingUpstreamMessage(kind: GenerateKind): string {
  if (kind === "summary" || kind === "test_me") {
    return "Generate Locked In first.";
  }
  if (kind === "carded") {
    return "Generate Summary first.";
  }
  return "No ingested sources to generate from. Video and audio are not processed in v1.";
}
