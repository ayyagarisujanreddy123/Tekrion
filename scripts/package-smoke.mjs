import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MINIMUM_NODE_VERSION } from "../packages/protocol/dist/index.js";
import { runtimePackages } from "./runtime-packages.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCliPath = process.env.npm_execpath;
const runtimePackageNames = new Set(runtimePackages.map(({ name }) => name));
const forbiddenPackagePaths = [
  /(^|\/)(?:src|test|tests|__tests__)(\/|$)/,
  /(?:blackbox|bbx)/i,
  /\.map$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:logs?)(\/|$)/,
  /\.(?:db|sqlite|sqlite3)(?:$|[.-])/,
];

async function executeNpm(arguments_, options) {
  assert.ok(
    npmCliPath,
    "npm_execpath is unavailable; run the package smoke test through npm",
  );
  return execute(process.execPath, [npmCliPath, ...arguments_], options);
}

function parsePackResult(stdout, packageName) {
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  const [result] = parsed;
  assert.equal(result.name, packageName);
  assert.ok(Array.isArray(result.files));
  return result;
}

function validatePackageContents(result) {
  const paths = result.files.map((file) => file.path);
  for (const path of paths) {
    assert.equal(
      forbiddenPackagePaths.some((pattern) => pattern.test(path)),
      false,
      `${result.name} contains forbidden package entry: ${path}`,
    );
  }

  assert.ok(paths.includes("dist/LICENSE"), `${result.name} lacks its license`);
  assert.ok(
    paths.includes("README.md"),
    `${result.name} lacks its package README`,
  );
  assert.ok(
    paths.includes("dist/index.js"),
    `${result.name} lacks dist/index.js`,
  );
  assert.ok(
    paths.includes("dist/index.d.ts"),
    `${result.name} lacks dist/index.d.ts`,
  );

  if (result.name === "@tekrion/cli") {
    assert.ok(
      paths.includes("dist/THIRD_PARTY_NOTICES"),
      "CLI lacks bundled dependency notices",
    );
    assert.ok(paths.includes("dist/bin.js"), "CLI lacks its executable");
    assert.ok(
      paths.includes("dist/viewer/index.html"),
      "CLI lacks viewer HTML",
    );
    assert.ok(
      paths.some((path) => /^dist\/viewer\/assets\/.+\.js$/.test(path)),
      "CLI lacks viewer JavaScript",
    );
    assert.ok(
      paths.some((path) => /^dist\/viewer\/assets\/.+\.css$/.test(path)),
      "CLI lacks viewer CSS",
    );
  }
}

async function validatePackageManifests() {
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const license = await readFile(join(repositoryRoot, "LICENSE"), "utf8");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(
    rootManifest.engines?.node,
    `>=${MINIMUM_NODE_VERSION}`,
    "root Node.js engine differs from the runtime compatibility check",
  );
  for (const runtimePackage of runtimePackages) {
    const manifest = JSON.parse(
      await readFile(
        join(repositoryRoot, runtimePackage.directory, "package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.name, runtimePackage.name);
    assert.equal(
      manifest.version,
      rootManifest.version,
      `${manifest.name} version differs from the release set`,
    );
    assert.equal(
      manifest.engines?.node,
      rootManifest.engines?.node,
      `${manifest.name} has a different Node.js compatibility contract`,
    );
    assert.equal(
      manifest.license,
      rootManifest.license,
      `${manifest.name} has a different license declaration`,
    );
    assert.equal(
      await readFile(
        join(repositoryRoot, runtimePackage.directory, "dist", "LICENSE"),
        "utf8",
      ),
      license,
      `${manifest.name} does not package the canonical license text`,
    );
    assert.ok(
      typeof manifest.description === "string" &&
        manifest.description.trim().length > 0,
      `${manifest.name} lacks a package description`,
    );

    for (const [dependency, version] of Object.entries(
      manifest.dependencies ?? {},
    )) {
      if (!dependency.startsWith("@tekrion/")) {
        continue;
      }
      assert.ok(
        runtimePackageNames.has(dependency),
        `${manifest.name} depends on unpacked runtime package ${dependency}`,
      );
      assert.equal(
        version,
        rootManifest.version,
        `${manifest.name} depends on ${dependency} at ${version}`,
      );
    }
  }
}

async function run() {
  await validatePackageManifests();
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tekrion-package-smoke-"));
  try {
    const packDirectory = join(temporaryRoot, "packages");
    const installDirectory = join(temporaryRoot, "install");
    await mkdir(packDirectory, { recursive: true });
    await mkdir(installDirectory, { recursive: true });

    const results = [];
    const archives = [];
    for (const { name: packageName } of runtimePackages) {
      const { stdout } = await executeNpm(
        [
          "pack",
          "--json",
          "--pack-destination",
          packDirectory,
          "--workspace",
          packageName,
        ],
        { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 },
      );
      const result = parsePackResult(stdout, packageName);
      validatePackageContents(result);
      results.push(result);
      archives.push(join(packDirectory, result.filename));
    }

    await writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "tekrion-package-smoke", private: true }, null, 2)}\n`,
    );
    await executeNpm(
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-save",
        "--package-lock=false",
        ...archives,
      ],
      { cwd: installDirectory, maxBuffer: 20 * 1024 * 1024 },
    );

    const binaryShim = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tekrion.cmd" : "tekrion",
    );
    await access(binaryShim);
    const installedCli = join(
      installDirectory,
      "node_modules",
      "@tekrion",
      "cli",
      "dist",
      "bin.js",
    );
    const help = await execute(process.execPath, [installedCli, "--help"], {
      cwd: installDirectory,
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.match(help.stdout, /Usage:\s+tekrion/);
    const version = await execute(
      process.execPath,
      [installedCli, "--version"],
      {
        cwd: installDirectory,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    assert.equal(version.stdout.trim(), rootManifest.version);

    const installedBin = await readFile(installedCli, "utf8");
    assert.match(installedBin, /^#!\/usr\/bin\/env node\r?\n/u);

    const tekrionHome = join(temporaryRoot, "home");
    await execute(
      process.execPath,
      [installedCli, "init", "--home", tekrionHome],
      {
        cwd: installDirectory,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const sessions = await execute(
      process.execPath,
      [installedCli, "sessions", "--home", tekrionHome, "--json"],
      { cwd: installDirectory, maxBuffer: 20 * 1024 * 1024 },
    );
    assert.deepEqual(JSON.parse(sessions.stdout), []);

    console.log("Package smoke test passed:");
    for (const result of results) {
      console.log(
        `- ${result.filename}: ${result.files.length} files, ${result.size.toLocaleString()} packed bytes`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await run();
