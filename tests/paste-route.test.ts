import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  createSourceForOwner: vi.fn(),
  getReviewer: vi.fn(),
}));
vi.mock("@/app/api/reviewers/[id]/sources/route", () => ({
  serializeSource: (row: { id: string; reviewerId: string; filename: string; mime: string; kind: string; blobPathname: string | null; ingestStatus: string; errorMessage: string | null; createdAt: Date }, sourceUrl: string | null) => ({
    id: row.id,
    reviewerId: row.reviewerId,
    filename: row.filename,
    mime: row.mime,
    kind: row.kind,
    blobUrl: sourceUrl,
    blobPathname: row.blobPathname,
    ingestStatus: row.ingestStatus,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  }),
}));

import { auth } from "@/auth";
import { createSourceForOwner, getReviewer } from "@/lib/queries";
import { MAX_PASTE_BODY_BYTES } from "@/lib/paste";
import { POST } from "@/app/api/reviewers/[id]/sources/paste/route";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const reviewerMock = getReviewer as unknown as ReturnType<typeof vi.fn>;
const createSourceMock = createSourceForOwner as unknown as ReturnType<typeof vi.fn>;

function request(body: unknown): Request {
  return new Request("https://omni-reviewer.example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("paste source route", () => {
  beforeEach(() => {
    authMock.mockReset();
    reviewerMock.mockReset();
    createSourceMock.mockReset();
    reviewerMock.mockResolvedValue({ id: "reviewer-1" });
    createSourceMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "Pasted notes",
      mime: "text/plain",
      kind: "paste",
      blobUrl: null,
      blobPathname: null,
      ingestStatus: "ready",
      errorMessage: null,
      createdAt: new Date("2026-08-30T00:00:00Z"),
    });
  });

  it("requires authentication and reviewer ownership", async () => {
    authMock.mockResolvedValue(null);
    expect((await POST(request({ text: "notes" }), { params: Promise.resolve({ id: "reviewer-1" }) })).status)
      .toBe(401);

    authMock.mockResolvedValue({ user: { id: "user-1" } });
    reviewerMock.mockResolvedValue(null);
    expect((await POST(request({ text: "notes" }), { params: Promise.resolve({ id: "reviewer-1" }) })).status)
      .toBe(404);
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("stores normalized plain text in the database without a Blob", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const response = await POST(
      request({ title: "  Lecture\nnotes  ", text: "\u0000first\r\nsecond" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(201);
    expect(createSourceMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      reviewerId: "reviewer-1",
      filename: "Lecture notes",
      mime: "text/plain",
      kind: "paste",
      blobUrl: null,
      blobPathname: null,
      ingestStatus: "ready",
      extractedText: "first\nsecond",
    }));
    expect(await response.json()).toMatchObject({ kind: "paste", blobUrl: null, blobPathname: null });
  });

  it("rejects empty, oversized, and invalid JSON input", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    expect((await POST(request({ text: "   " }), { params: Promise.resolve({ id: "reviewer-1" }) })).status)
      .toBe(400);
    expect((await POST(request({ text: "x".repeat(200_001) }), { params: Promise.resolve({ id: "reviewer-1" }) })).status)
      .toBe(400);
    const malformed = await POST(
      new Request("https://omni-reviewer.example", { method: "POST", body: "nope" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(malformed.status).toBe(400);
    expect(createSourceMock).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before JSON parsing and rejects unknown keys", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const declaredTooLarge = await POST(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Length": String(MAX_PASTE_BODY_BYTES + 1) },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(declaredTooLarge.status).toBe(413);

    const oversizedChunk = new Uint8Array(MAX_PASTE_BODY_BYTES + 1);
    const streamedTooLarge = await POST(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        duplex: "half",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversizedChunk);
            controller.close();
          },
        }),
      } as RequestInit & { duplex: "half" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(streamedTooLarge.status).toBe(413);

    const unknownKey = await POST(
      request({ text: "notes", unexpected: "do not accept" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(unknownKey.status).toBe(400);
    expect(createSourceMock).not.toHaveBeenCalled();
  });
});
