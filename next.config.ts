import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF route launches the bundled Chromium, whose binaries are read from disk at runtime.
  outputFileTracingIncludes: {
    "/api/reviewers/\\[id\\]/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
