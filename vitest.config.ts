import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration suites talk to a real database; give them room beyond the defaults and
// retry connections that never opened (undici's 10 s connect timeout from this Mac).
const integrationTimeouts =
  process.env.RUN_DB_INTEGRATION === "1"
    ? { testTimeout: 30_000, hookTimeout: 30_000, setupFiles: ["tests/support/integration-setup.ts"] }
    : {};

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    ...integrationTimeouts,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
