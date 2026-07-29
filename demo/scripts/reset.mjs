import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const templateRoot = join(repositoryRoot, "demo", "rogue-repo-template");

function safeDemoRoot(value) {
  const outputRoot = resolve(value);
  if (
    outputRoot === parse(outputRoot).root ||
    outputRoot === repositoryRoot ||
    !basename(outputRoot).toLowerCase().includes("tekrion-demo")
  ) {
    throw new Error(
      "Demo output must be a dedicated directory whose name contains 'tekrion-demo'.",
    );
  }
  return outputRoot;
}

export async function resetDemo(options = {}) {
  const outputRoot = safeDemoRoot(
    options.outputRoot ?? join(repositoryRoot, ".tekrion-demo"),
  );
  await rm(outputRoot, { recursive: true, force: true });
  if (options.clean === true) {
    return { outputRoot, cleaned: true };
  }
  const workspace = join(outputRoot, "rogue-repo");
  const home = join(outputRoot, "home");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await cp(templateRoot, workspace, { recursive: true, errorOnExist: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await execute("git", ["-C", workspace, "init", "--quiet"]);
  await execute("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "tekrion-demo@example.test",
  ]);
  await execute("git", [
    "-C",
    workspace,
    "config",
    "user.name",
    "Tekrion Demo",
  ]);
  await execute("git", ["-C", workspace, "add", "."]);
  await execute("git", [
    "-C",
    workspace,
    "commit",
    "--quiet",
    "-m",
    "seeded Tekrion demo baseline",
  ]);
  return { outputRoot, workspace, home, cleaned: false };
}

function argumentsFrom(argv) {
  let outputRoot;
  let clean = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clean") {
      clean = true;
    } else if (argument === "--output") {
      outputRoot = argv[index + 1];
      if (outputRoot === undefined) {
        throw new Error("--output requires a directory.");
      }
      index += 1;
    } else {
      throw new Error(`Unknown demo reset argument ${argument}.`);
    }
  }
  return { ...(outputRoot === undefined ? {} : { outputRoot }), clean };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await resetDemo(argumentsFrom(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `tekrion demo reset: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
