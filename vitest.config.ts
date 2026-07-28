import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@blackbox/analysis": fileURLToPath(
        new URL("./packages/analysis/src/index.ts", import.meta.url),
      ),
      "@blackbox/context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@blackbox/daemon": fileURLToPath(
        new URL("./apps/daemon/src/index.ts", import.meta.url),
      ),
      "@blackbox/normalizers": fileURLToPath(
        new URL("./packages/normalizers/src/index.ts", import.meta.url),
      ),
      "@blackbox/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@blackbox/storage": fileURLToPath(
        new URL("./packages/storage/src/index.ts", import.meta.url),
      ),
      "@blackbox/test-fixtures": fileURLToPath(
        new URL("./packages/test-fixtures/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    maxWorkers: 4,
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
