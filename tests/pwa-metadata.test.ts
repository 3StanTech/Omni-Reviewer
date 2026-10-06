import { describe, expect, it, vi } from "vitest";

// proxy.ts initializes Auth.js at import; only its static matcher is under test.
vi.mock("next-auth", () => ({
  default: () => ({ auth: (handler: unknown) => handler }),
}));

import manifest from "@/app/manifest";
import { config } from "@/proxy";

describe("web app manifest", () => {
  it("installs from the root as a standalone app", () => {
    const m = manifest();
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons?.map(({ src, sizes, purpose }) => ({ src, sizes, purpose }))).toEqual([
      { src: "/icon/192", sizes: "192x192", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", purpose: "maskable" },
    ]);
  });
});

describe("proxy matcher", () => {
  const matcher = new RegExp("^" + config.matcher[0] + "$");

  it.each(["/manifest.webmanifest", "/icon/192", "/icon/512", "/icon", "/apple-icon"])(
    "leaves %s public",
    (path) => {
      expect(matcher.test(path)).toBe(false);
    },
  );

  it.each([
    "/",
    "/api/reviewers",
    "/login",
    "/topics/x/reviewers/y",
    "/iconography",
    "/icons-something",
    "/apple-icons",
    "/manifest.webmanifestx",
  ])("still gates %s", (path) => {
    expect(matcher.test(path)).toBe(true);
  });
});
