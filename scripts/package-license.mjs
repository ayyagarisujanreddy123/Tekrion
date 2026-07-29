import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimePackages } from "./runtime-packages.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const license = await readFile(join(repositoryRoot, "LICENSE"));

async function packageLicense(packageName) {
  const packageDirectory = join(repositoryRoot, "node_modules", packageName);
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    try {
      return {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        text: await readFile(join(packageDirectory, filename), "utf8"),
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`${packageName} has no distributable license file`);
}

async function bundledViewerPackages() {
  const assetDirectory = join(
    repositoryRoot,
    "apps",
    "viewer",
    "dist",
    "public",
    "assets",
  );
  const sourceMaps = (await readdir(assetDirectory)).filter((filename) =>
    filename.endsWith(".js.map"),
  );
  if (sourceMaps.length !== 1) {
    throw new Error(
      `Expected one production viewer source map, found ${sourceMaps.length}`,
    );
  }
  const sourceMap = JSON.parse(
    await readFile(join(assetDirectory, sourceMaps[0]), "utf8"),
  );
  const packages = new Set();
  for (const source of sourceMap.sources) {
    for (const match of source.matchAll(
      /node_modules\/((?:@[^/]+\/)?[^/]+)/g,
    )) {
      if (!match[1].startsWith("@tekrion/")) {
        packages.add(match[1]);
      }
    }
  }
  return [...packages].sort();
}

async function thirdPartyNotices() {
  const packages = await Promise.all(
    (await bundledViewerPackages()).map(packageLicense),
  );
  const licenses = new Map();
  for (const package_ of packages) {
    const group = licenses.get(package_.text) ?? [];
    group.push(package_);
    licenses.set(package_.text, group);
  }

  const sections = [
    "# Third-party notices",
    "",
    "The Tekrion browser assets include the following production dependencies.",
  ];
  for (const [text, group] of licenses) {
    sections.push(
      "",
      `## ${group.map(({ name, version }) => `${name}@${version}`).join(", ")}`,
      "",
      `Declared license: ${[...new Set(group.map(({ license: value }) => value))].join(", ")}`,
      "",
      text.trimEnd(),
    );
  }
  return `${sections.join("\n")}\n`;
}

await Promise.all(
  runtimePackages.map(async ({ directory }) => {
    const distributionDirectory = join(repositoryRoot, directory, "dist");
    await mkdir(distributionDirectory, { recursive: true });
    await writeFile(join(distributionDirectory, "LICENSE"), license);
  }),
);

await writeFile(
  join(repositoryRoot, "apps", "cli", "dist", "THIRD_PARTY_NOTICES"),
  await thirdPartyNotices(),
);
