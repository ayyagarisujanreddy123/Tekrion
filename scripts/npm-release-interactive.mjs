import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runtimePackages } from "./runtime-packages.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCliPath = process.env.npm_execpath;
const [operation, expectedSha, ...unexpectedArguments] = process.argv.slice(2);
const supportedOperations = new Set(["publish-next", "promote-latest"]);
const maximumOutputBytes = 20 * 1024 * 1024;
const registryVerificationAttempts = 60;
const registryVerificationDelayMs = 5_000;

if (
  !supportedOperations.has(operation) ||
  !/^[0-9a-f]{40}$/u.test(expectedSha ?? "") ||
  unexpectedArguments.length > 0
) {
  process.stderr.write(
    "Usage: npm run release:publish:interactive -- <40-character-sha>\n" +
      "   or: npm run release:promote:interactive -- <40-character-sha>\n",
  );
  process.exitCode = 2;
} else {
  try {
    await run();
  } catch (error) {
    process.stderr.write(
      `npm release operation stopped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function run() {
  if (npmCliPath === undefined) {
    throw new Error("run this command through npm so its CLI can be located");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "an interactive terminal is required so npm can request two-factor authentication",
    );
  }
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
    throw new Error(
      "remove NODE_AUTH_TOKEN and NPM_TOKEN; first publication must use the interactive npm login session",
    );
  }

  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("the root package version is missing");
  }

  await verifyCheckout();
  const identity = (await executeNpm(["whoami"])).stdout.trim();
  const tfa = JSON.parse(
    (await executeNpm(["profile", "get", "tfa", "--json"])).stdout,
  );
  const tfaMode = typeof tfa === "string" ? tfa : (tfa?.mode ?? tfa?.tfa?.mode);
  if (tfaMode !== "auth-and-writes") {
    throw new Error(
      `npm identity ${identity} must enable auth-and-writes two-factor authentication`,
    );
  }
  process.stdout.write(`Authenticated npm identity: ${identity}\n`);

  if (operation === "publish-next") {
    await publishNext(version);
  } else {
    await promoteLatest(version);
  }
}

async function verifyCheckout() {
  const [{ stdout: head }, { stdout: branch }, { stdout: status }] =
    await Promise.all([
      execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
      execute("git", ["branch", "--show-current"], { cwd: repositoryRoot }),
      execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: repositoryRoot,
      }),
    ]);
  const { stdout: originMain } = await execute(
    "git",
    ["rev-parse", "origin/main"],
    { cwd: repositoryRoot },
  );

  if (head.trim() !== expectedSha) {
    throw new Error(`HEAD ${head.trim()} does not match ${expectedSha}`);
  }
  if (originMain.trim() !== expectedSha) {
    throw new Error(
      `origin/main ${originMain.trim()} does not match ${expectedSha}`,
    );
  }
  if (branch.trim() !== "main") {
    throw new Error(
      `publication requires main, not ${branch.trim() || "detached HEAD"}`,
    );
  }
  if (status.trim().length > 0) {
    throw new Error("the repository has uncommitted or untracked files");
  }
}

async function publishNext(version) {
  process.stdout.write("Re-running the complete release preflight...\n");
  await executeNpmInteractive(["run", "release:preflight"]);

  for (const { name } of runtimePackages) {
    await requireVersionAbsent(name, version);
  }

  await requireConfirmation(
    `publish-${version}-to-next`,
    "npm versions are immutable and a failure can leave a partial release",
  );

  for (const { name } of runtimePackages) {
    process.stdout.write(`Publishing ${name}@${version} to next...\n`);
    await executeNpmInteractive([
      "publish",
      `--workspace=${name}`,
      "--access",
      "public",
      "--tag",
      "next",
    ]);
    await requireTagVersion(name, version, "next");
  }

  process.stdout.write(
    `Published all ${runtimePackages.length} packages at ${version} to next.\n`,
  );
}

async function promoteLatest(version) {
  for (const { name } of runtimePackages) {
    await requireTagVersion(name, version, "next");
  }

  await requireConfirmation(
    `promote-${version}-to-latest`,
    "latest becomes the default version installed by npm users",
  );

  for (const { name } of runtimePackages) {
    process.stdout.write(`Promoting ${name}@${version} to latest...\n`);
    await executeNpmInteractive([
      "dist-tag",
      "add",
      `${name}@${version}`,
      "latest",
    ]);
    await requireTagVersion(name, version, "latest");
  }

  process.stdout.write(
    `Promoted all ${runtimePackages.length} packages at ${version} to latest.\n`,
  );
}

async function requireVersionAbsent(name, version) {
  try {
    await executeNpm([
      "view",
      `${name}@${version}`,
      "version",
      "--json",
      "--prefer-online",
    ]);
  } catch (error) {
    const output = `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
    if (output.includes("E404")) {
      return;
    }
    throw new Error(`could not prove ${name}@${version} is absent from npm`, {
      cause: error,
    });
  }
  throw new Error(
    `${name}@${version} already exists; refusing a publication rerun`,
  );
}

async function requireTagVersion(name, version, tag) {
  let lastError;
  for (let attempt = 1; attempt <= registryVerificationAttempts; attempt += 1) {
    try {
      const { stdout } = await executeNpm([
        "view",
        `${name}@${tag}`,
        "version",
        "--json",
        "--prefer-online",
      ]);
      if (JSON.parse(stdout) === version) {
        return;
      }
      lastError = new Error(`${name}@${tag} did not resolve to ${version}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 1) {
      process.stdout.write(
        `Waiting for npm registry propagation of ${name}@${tag}...\n`,
      );
    }
    if (attempt < registryVerificationAttempts) {
      await delay(registryVerificationDelayMs);
    }
  }
  throw new Error(
    `${name}@${tag} did not resolve to ${version}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

async function requireConfirmation(expected, consequence) {
  process.stdout.write(`Warning: ${consequence}.\n`);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await terminal.question(`Type ${expected} to continue: `);
    if (answer !== expected) {
      throw new Error("confirmation did not match; nothing was changed");
    }
  } finally {
    terminal.close();
  }
}

function executeNpm(arguments_) {
  return execute(process.execPath, [npmCliPath, ...arguments_], {
    cwd: repositoryRoot,
    maxBuffer: maximumOutputBytes,
  });
}

function executeNpmInteractive(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [npmCliPath, ...arguments_], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `npm ${arguments_[0]} exited with ${code === null ? `signal ${String(signal)}` : `status ${code}`}`,
        ),
      );
    });
  });
}
