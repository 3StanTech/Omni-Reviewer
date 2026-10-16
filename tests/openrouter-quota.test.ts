import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ OPENROUTER_API_KEY: "sk-or-test-secret" }) }));
vi.mock("@/lib/free-request-ledger", () => ({ readFreeRequestState: vi.fn() }));

import { auth } from "@/auth";
import { readFreeRequestState } from "@/lib/free-request-ledger";
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
  mock(readFreeRequestState).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readFreeRequestQuota", () => {
  it("reads only the daily limit from the key endpoint", async () => {
    fetchMock.mockResolvedValueOnce(keyResponse({ used: 0, limit: 50, remaining: 50 }));
    await expect(readFreeRequestQuota()).resolves.toEqual({ limit: 50 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test-secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when the quota block is absent", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it.each([{ limit: "50" }, { limit: null }, { limit: 0 }, { limit: Number.NaN }])(
    "returns null for a non-numeric or non-positive limit %j",
    async (daily) => {
      fetchMock.mockResolvedValueOnce(keyResponse(daily));
      await expect(readFreeRequestQuota()).resolves.toBeNull();
    },
  );

  it("returns null on a non-OK response or a failed fetch", async () => {
    fetchMock.mockResolvedValueOnce(keyResponse({ limit: 50 }, 401));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(readFreeRequestQuota()).resolves.toBeNull();
  });

  it("serves a cached read within 60 seconds and refreshes after or when fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(keyResponse({ limit: 50 }))
      .mockResolvedValueOnce(keyResponse({ limit: 1000 }))
      .mockResolvedValueOnce(keyResponse({ limit: 50 }));

    await expect(readFreeRequestQuota()).resolves.toEqual({ limit: 50 });
    vi.setSystemTime(new Date("2026-10-05T00:00:59Z"));
    await expect(readFreeRequestQuota()).resolves.toEqual({ limit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-05T00:01:01Z"));
    await expect(readFreeRequestQuota()).resolves.toEqual({ limit: 1000 });
    await expect(readFreeRequestQuota({ fresh: true })).resolves.toEqual({ limit: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function quotaRequest(query = "") {
  return new Request(`http://localhost/api/quota${query}`);
}

describe("GET /api/quota", () => {
  it("returns 401 without a session and reads nothing", async () => {
    mock(auth).mockResolvedValueOnce(null);
    const response = await GET(quotaRequest("?fresh=1"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(readFreeRequestState).not.toHaveBeenCalled();
  });

  it("returns the ledger state, uncached, and passes fresh through", async () => {
    const state = { limited: true, limit: 50, requestsLeft: 26, packsLeft: 2, exhausted: false };
    mock(auth).mockResolvedValue({ user: { id: "user-1" } });
    mock(readFreeRequestState).mockResolvedValue(state);

    const response = await GET(quotaRequest());
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(state);
    expect(readFreeRequestState).toHaveBeenLastCalledWith({ fresh: false });

    await GET(quotaRequest("?fresh=1"));
    expect(readFreeRequestState).toHaveBeenLastCalledWith({ fresh: true });
  });
});
