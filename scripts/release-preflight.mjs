import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  dualUseRuntimePackageNames,
  runtimePackages,
} from "./runtime-packages.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCliPath = process.env.npm_execpath;
const gitExecutable = "git";
const maximumOutputBytes = 100 * 1024 * 1024;
const dualUsePackageNames = new Set(dualUseRuntimePackageNames);
const privateWorkspaceDirectories = [
  ".",
  "apps/demo-agent",
  "apps/viewer",
  "packages/adapters",
  "packages/test-fixtures",
];
const acceptedArguments = new Set(["--json"]);
const arguments_ = process.argv.slice(2);

for (const argument of arguments_) {
  if (!acceptedArguments.has(argument)) {
    process.stderr.write(`Unknown release preflight option: ${argument}\n`);
    process.exitCode = 2;
  }
}

if (process.exitCode === 2) {
  process.stderr.write("Usage: npm run release:preflight -- [--json]\n");
} else {
  await runPreflight(arguments_.includes("--json"));
}

function passed(id, label, summary) {
  return { id, label, status: "pass", summary };
}

function failed(id, label, summary, details) {
  return {
    id,
    label,
    status: "fail",
    summary,
    ...(details === undefined ? {} : { details }),
  };
}

function outputTail(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-20)
    .join("\n");
}

async function commandCheck(id, label, arguments_) {
  process.stderr.write(`Checking ${label.toLowerCase()}...\n`);
  try {
    if (npmCliPath === undefined) {
      throw Object.assign(
        new Error(
          "npm_execpath is unavailable; run release preflight through npm",
        ),
        { code: "ENPMEXEC" },
      );
    }
    await execute(process.execPath, [npmCliPath, ...arguments_], {
      cwd: repositoryRoot,
      maxBuffer: maximumOutputBytes,
    });
    return passed(id, label, "completed successfully");
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return failed(
      id,
      label,
      `command exited with status ${String(error.code ?? "unknown")}`,
      outputTail(`${stdout}\n${stderr}`),
    );
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function repositoryUrl(manifest) {
  if (typeof manifest.repository === "string") {
    return manifest.repository;
  }
  if (
    typeof manifest.repository === "object" &&
    manifest.repository !== null &&
    typeof manifest.repository.url === "string"
  ) {
    return manifest.repository.url;
  }
  return undefined;
}

async function firstExistingFile(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return undefined;
}

async function manifestChecks() {
  const rootManifest = await readJson(join(repositoryRoot, "package.json"));
  const manifests = await Promise.all(
    runtimePackages.map(async (runtimePackage) => ({
      runtimePackage,
      manifest: await readJson(
        join(repositoryRoot, runtimePackage.directory, "package.json"),
      ),
    })),
  );
  const privateWorkspaceManifests = await Promise.all(
    privateWorkspaceDirectories.map(async (directory) => ({
      directory,
      manifest:
        directory === "."
          ? rootManifest
          : await readJson(join(repositoryRoot, directory, "package.json")),
    })),
  );
  const checks = [];

  const candidateVersion = rootManifest.version;
  checks.push(
    typeof candidateVersion === "string" && candidateVersion !== "0.0.0"
      ? passed("candidate-version", "Candidate version", candidateVersion)
      : failed(
          "candidate-version",
          "Candidate version",
          "replace the 0.0.0 development placeholder with an authorized release version",
        ),
  );

  const misalignedVersions = manifests
    .filter(({ manifest }) => manifest.version !== candidateVersion)
    .map(({ manifest }) => `${manifest.name}@${manifest.version}`);
  checks.push(
    misalignedVersions.length === 0
      ? passed(
          "version-alignment",
          "Runtime version alignment",
          `${manifests.length} package versions match ${candidateVersion}`,
        )
      : failed(
          "version-alignment",
          "Runtime version alignment",
          "runtime package versions differ from the root candidate",
          misalignedVersions.join("\n"),
        ),
  );

  const privatePackages = manifests
    .filter(({ manifest }) => manifest.private === true)
    .map(({ manifest }) => manifest.name);
  checks.push(
    privatePackages.length === 0
      ? passed(
          "publishable-packages",
          "Publishable runtime packages",
          "no runtime package is marked private",
        )
      : failed(
          "publishable-packages",
          "Publishable runtime packages",
          `${privatePackages.length} runtime packages are still private`,
          privatePackages.join("\n"),
        ),
  );

  const exposedDevelopmentWorkspaces = privateWorkspaceManifests
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ directory, manifest }) => `${manifest.name} (${directory})`);
  checks.push(
    exposedDevelopmentWorkspaces.length === 0
      ? passed(
          "private-development-workspaces",
          "Private development workspaces",
          `${privateWorkspaceManifests.length} non-runtime workspaces remain protected`,
        )
      : failed(
          "private-development-workspaces",
          "Private development workspaces",
          "one or more non-runtime workspaces could be published accidentally",
          exposedDevelopmentWorkspaces.join("\n"),
        ),
  );

  const licenseFile = await firstExistingFile(
    ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((name) =>
      join(repositoryRoot, name),
    ),
  );
  const declaredLicense = rootManifest.license;
  const packageLicenseMismatches = manifests
    .filter(({ manifest }) => manifest.license !== declaredLicense)
    .map(({ manifest }) => manifest.name);
  checks.push(
    licenseFile !== undefined &&
      typeof declaredLicense === "string" &&
      declaredLicense.length > 0 &&
      declaredLicense !== "UNLICENSED" &&
      packageLicenseMismatches.length === 0
      ? passed(
          "license",
          "License declaration",
          `${declaredLicense} is declared across the release set`,
        )
      : failed(
          "license",
          "License declaration",
          "choose a license, add its file, and declare it consistently in every runtime manifest",
          packageLicenseMismatches.length === 0
            ? undefined
            : `Missing or mismatched: ${packageLicenseMismatches.join(", ")}`,
        ),
  );

  const rootRepository = repositoryUrl(rootManifest);
  const missingRepository = manifests
    .filter(({ manifest }) => repositoryUrl(manifest) !== rootRepository)
    .map(({ manifest }) => manifest.name);
  checks.push(
    rootRepository !== undefined && missingRepository.length === 0
      ? passed("repository-metadata", "Repository metadata", rootRepository)
      : failed(
          "repository-metadata",
          "Repository metadata",
          "declare the canonical repository in the root and every runtime manifest",
          missingRepository.length === 0
            ? undefined
            : `Missing or mismatched: ${missingRepository.join(", ")}`,
        ),
  );

  const invalidPublishConfiguration = manifests
    .filter(({ manifest }) => manifest.publishConfig?.access !== "public")
    .map(({ manifest }) => manifest.name);
  checks.push(
    invalidPublishConfiguration.length === 0
      ? passed(
          "publish-configuration",
          "Publish configuration",
          "all scoped runtime packages explicitly publish with public access",
        )
      : failed(
          "publish-configuration",
          "Publish configuration",
          "explicit public access is missing from scoped runtime packages",
          invalidPublishConfiguration.join("\n"),
        ),
  );

  const invalidDualUseDeclarations = [];
  for (const { runtimePackage, manifest } of manifests) {
    if (!dualUsePackageNames.has(manifest.name)) {
      continue;
    }
    const disclosure = await firstExistingFile([
      join(repositoryRoot, runtimePackage.directory, "DISCLOSURE"),
    ]);
    if (
      manifest.contentPolicy?.class !== "dual-use" ||
      !Array.isArray(manifest.files) ||
      !manifest.files.includes("DISCLOSURE") ||
      disclosure === undefined
    ) {
      invalidDualUseDeclarations.push(manifest.name);
    }
  }
  checks.push(
    invalidDualUseDeclarations.length === 0
      ? passed(
          "dual-use-declarations",
          "Dual-use declarations",
          `${dualUsePackageNames.size} capture packages include npm metadata and disclosures`,
        )
      : failed(
          "dual-use-declarations",
          "Dual-use declarations",
          "capture packages must declare npm dual-use metadata and package a DISCLOSURE file",
          invalidDualUseDeclarations.join("\n"),
        ),
  );

  const missingPackageReadmes = [];
  for (const { runtimePackage, manifest } of manifests) {
    const readme = await firstExistingFile(
      ["README.md", "README", "README.txt"].map((name) =>
        join(repositoryRoot, runtimePackage.directory, name),
      ),
    );
    if (readme === undefined) {
      missingPackageReadmes.push(manifest.name);
    }
  }
  checks.push(
    missingPackageReadmes.length > 0
      ? failed(
          "package-readmes",
          "Runtime package READMEs",
          "add package-local documentation for every npm listing",
          missingPackageReadmes.join("\n"),
        )
      : passed(
          "package-readmes",
          "Runtime package READMEs",
          `${manifests.length} package-local READMEs are present`,
        ),
  );

  return checks;
}

async function repositoryChecks() {
  const { stdout: commit } = await execute(
    gitExecutable,
    ["rev-parse", "HEAD"],
    {
      cwd: repositoryRoot,
      maxBuffer: maximumOutputBytes,
    },
  );
  const { stdout: status } = await execute(
    gitExecutable,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, maxBuffer: maximumOutputBytes },
  );
  const entries = status.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    commit: commit.trim(),
    check:
      entries.length === 0
        ? passed(
            "clean-tree",
            "Repository cleanliness",
            "candidate tree is clean",
          )
        : failed(
            "clean-tree",
            "Repository cleanliness",
            `${entries.length} working-tree entries are not committed`,
            entries.slice(0, 20).join("\n"),
          ),
  };
}

function writeTextReport(report) {
  process.stdout.write(
    `Release preflight: ${report.ready ? "READY" : "NOT READY"}\n`,
  );
  process.stdout.write(`Commit: ${report.commit}\n`);
  for (const check of report.checks) {
    process.stdout.write(
      `${check.status === "pass" ? "PASS" : "FAIL"} ${check.label}: ${check.summary}\n`,
    );
    if (check.status === "fail" && check.details !== undefined) {
      for (const line of check.details.split("\n")) {
        process.stdout.write(`     ${line}\n`);
      }
    }
  }
}

async function runPreflight(json) {
  const checks = [
    await commandCheck("source-gates", "Source gates", ["run", "check"]),
    await commandCheck("package-smoke", "Package smoke test", [
      "run",
      "package:smoke",
    ]),
    await commandCheck("dependency-audit", "Dependency audit", [
      "audit",
      "--audit-level=high",
    ]),
    ...(await manifestChecks()),
  ];
  const repository = await repositoryChecks();
  checks.push(repository.check);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: repository.commit,
    ready: checks.every((check) => check.status === "pass"),
    checks,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    writeTextReport(report);
  }
  process.exitCode = report.ready ? 0 : 1;
}
