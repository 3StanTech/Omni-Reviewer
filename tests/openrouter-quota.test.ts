import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ OPENROUTER_API_KEY: "sk-or-test-secret" }) }));

import { auth } from "@/auth";
import { readFreeRequestQuota, resetFreeRequestQuotaCache } from "@/lib/openrouter-quota";
import { GET } from "@/app/api/quota/route";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

function keyResponse(daily: unknown, status = 200) {
  return new Response(
    JSON.stringify({ data: { label: "sk-or-test-secret", usage: 0, free_model_daily_requests: daily } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  resetFreeRequestQuotaCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mock(auth).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readFreeRequestQuota", () => {
  it("reads used, limit, and remaining from the key endpoint", async () => {
    fetchMock.mockResolvedValueOnce(keyResponse({ used: 12, limit: 50, remaining: 38 }));
    await expect(readFreeRequestQuota()).resolves.toEqual({ used: 12, limit: 50, remaining: 38 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test-secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when a field is missing", async () => {
    fetchMock.mockResolvedValueOnce(keyResponse({ used: 12, limit: 50 }));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it("returns null when the quota block is absent", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it.each([
    { used: "12", limit: 50, remaining: 38 },
    { used: 12, limit: null, remaining: 38 },
    { used: 12, limit: 50, remaining: -1 },
    { used: Number.NaN, limit: 50, remaining: 38 },
  ])("returns null for non-numeric or negative fields %j", async (daily) => {
    fetchMock.mockResolvedValueOnce(keyResponse(daily));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(keyResponse({ used: 1, limit: 50, remaining: 49 }, 401));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it("serves a cached read within 60 seconds and refreshes after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(keyResponse({ used: 10, limit: 50, remaining: 40 }))
      .mockResolvedValueOnce(keyResponse({ used: 20, limit: 50, remaining: 30 }));

    await expect(readFreeRequestQuota()).resolves.toMatchObject({ remaining: 40 });
    vi.setSystemTime(new Date("2026-10-05T00:00:59Z"));
    await expect(readFreeRequestQuota()).resolves.toMatchObject({ remaining: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-05T00:01:01Z"));
    await expect(readFreeRequestQuota()).resolves.toMatchObject({ remaining: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses a warm cache when fresh and refreshes it", async () => {
    fetchMock
      .mockResolvedValueOnce(keyResponse({ used: 10, limit: 50, remaining: 40 }))
      .mockResolvedValueOnce(keyResponse({ used: 14, limit: 50, remaining: 36 }));

    await expect(readFreeRequestQuota()).resolves.toMatchObject({ remaining: 40 });
    await expect(readFreeRequestQuota({ fresh: true })).resolves.toMatchObject({ remaining: 36 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(readFreeRequestQuota()).resolves.toMatchObject({ remaining: 36 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function quotaRequest(query = "") {
  return new Request(`http://localhost/api/quota${query}`);
}

describe("GET /api/quota", () => {
  it("returns 401 without a session and does not call OpenRouter", async () => {
    mock(auth).mockResolvedValueOnce(null);
    const response = await GET(quotaRequest("?fresh=1"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only remaining and limit with a session", async () => {
    mock(auth).mockResolvedValueOnce({ user: { id: "user-1" } });
    fetchMock.mockResolvedValueOnce(keyResponse({ used: 8, limit: 50, remaining: 42 }));
    const response = await GET(quotaRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ remaining: 42, limit: 50 });
    expect(text).not.toContain("sk-or-test-secret");
  });

  it("returns nulls when the quota cannot be read", async () => {
    mock(auth).mockResolvedValueOnce({ user: { id: "user-1" } });
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const response = await GET(quotaRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ remaining: null, limit: null });
  });

  it("serves the cache without fresh and reads upstream with fresh=1", async () => {
    mock(auth).mockResolvedValue({ user: { id: "user-1" } });
    fetchMock
      .mockResolvedValueOnce(keyResponse({ used: 8, limit: 50, remaining: 42 }))
      .mockResolvedValueOnce(keyResponse({ used: 11, limit: 50, remaining: 39 }));

    expect(await (await GET(quotaRequest())).json()).toEqual({ remaining: 42, limit: 50 });
    expect(await (await GET(quotaRequest())).json()).toEqual({ remaining: 42, limit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await (await GET(quotaRequest("?fresh=1"))).json()).toEqual({ remaining: 39, limit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
