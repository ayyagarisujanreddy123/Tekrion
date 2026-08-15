export const runtimePackages = Object.freeze([
  Object.freeze({ name: "@tekrion/protocol", directory: "packages/protocol" }),
  Object.freeze({ name: "@tekrion/storage", directory: "packages/storage" }),
  Object.freeze({
    name: "@tekrion/normalizers",
    directory: "packages/normalizers",
  }),
  Object.freeze({ name: "@tekrion/context", directory: "packages/context" }),
  Object.freeze({
    name: "@tekrion/analysis",
    directory: "packages/analysis",
  }),
  Object.freeze({ name: "@tekrion/daemon", directory: "apps/daemon" }),
  Object.freeze({ name: "@tekrion/cli", directory: "apps/cli" }),
]);

export const dualUseRuntimePackageNames = Object.freeze([
  "@tekrion/daemon",
  "@tekrion/cli",
]);
