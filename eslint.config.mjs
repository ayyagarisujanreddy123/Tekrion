import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".tekrion-demo/**",
      ".blackbox-demo/**",
      "coverage/**",
      "demo/rogue-repo-template/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {},
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tekrion/viewer", "@tekrion/viewer/*"],
              message:
                "Runtime packages must not depend on the viewer application.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/cli/**/*.ts",
      "apps/daemon/**/*.ts",
      "apps/demo-agent/**/*.ts",
      "packages/**/*.ts",
      "vitest*.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["demo/scripts/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/viewer/**/*.ts", "apps/viewer/**/*.tsx"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  prettier,
);
