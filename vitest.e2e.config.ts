import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});
