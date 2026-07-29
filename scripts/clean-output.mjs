import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const workspaceRoots = await Promise.all(
  ["apps", "packages"].map(async (directory) => {
    const root = join(repositoryRoot, directory);
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "dist"));
  }),
);

await Promise.all(
  workspaceRoots
    .flat()
    .map((directory) => rm(directory, { recursive: true, force: true })),
);
