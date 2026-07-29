import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tekrion/analysis": fileURLToPath(
        new URL("./packages/analysis/src/index.ts", import.meta.url),
      ),
      "@tekrion/context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@tekrion/daemon": fileURLToPath(
        new URL("./apps/daemon/src/index.ts", import.meta.url),
      ),
      "@tekrion/normalizers": fileURLToPath(
        new URL("./packages/normalizers/src/index.ts", import.meta.url),
      ),
      "@tekrion/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@tekrion/storage": fileURLToPath(
        new URL("./packages/storage/src/index.ts", import.meta.url),
      ),
      "@tekrion/test-fixtures": fileURLToPath(
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
