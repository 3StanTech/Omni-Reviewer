import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration suites talk to a real database; give them room beyond the defaults.
const integrationTimeouts =
  process.env.RUN_DB_INTEGRATION === "1"
    ? { testTimeout: 30_000, hookTimeout: 30_000 }
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
