import { describe, expect, it, vi } from "vitest";

import { connectRetryFetch } from "./support/neon-connect-retry";

const connectTimeout = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

describe("connectRetryFetch", () => {
  it("retries a connection that never opened, then returns the response", async () => {
    const response = new Response("ok");
    const base = vi.fn<typeof fetch>().mockRejectedValueOnce(connectTimeout()).mockResolvedValueOnce(response);
    await expect(connectRetryFetch(base)("https://db.example/sql")).resolves.toBe(response);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt limit", async () => {
    const base = vi.fn<typeof fetch>().mockRejectedValue(connectTimeout());
    await expect(connectRetryFetch(base, 3)("https://db.example/sql")).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("never retries other failures, which may have reached the database", async () => {
    const base = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    await expect(connectRetryFetch(base)("https://db.example/sql")).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(1);
  });
});
