import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resetDemo } from "./reset.mjs";
import { seedFixture } from "./seed-fixture.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function outputFrom(argv) {
  if (argv.length === 0) {
    return undefined;
  }
  if (argv[0] !== "--output" || argv[1] === undefined || argv.length !== 2) {
    throw new Error("Usage: run-offline.mjs [--output DIRECTORY]");
  }
  return argv[1];
}

try {
  const outputRoot = outputFrom(process.argv.slice(2));
  const reset = await resetDemo(outputRoot === undefined ? {} : { outputRoot });
  const seeded = await seedFixture(reset.home);
  const cliPath = join(repositoryRoot, "apps", "cli", "dist", "bin.js");
  const report = await execute(
    process.execPath,
    [
      cliPath,
      "report",
      seeded.sessionId,
      "--target-event",
      seeded.targetEventId,
      "--home",
      reset.home,
      "--json",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const result = JSON.parse(report.stdout);
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.markdown !== "string"
  ) {
    throw new Error("The packaged CLI returned an invalid report result.");
  }
  const markdownPath = join(reset.outputRoot, "incident-report.md");
  const jsonPath = join(reset.outputRoot, "incident-report.json");
  await Promise.all([
    writeFile(markdownPath, result.markdown, { encoding: "utf8", mode: 0o600 }),
    writeFile(jsonPath, `${JSON.stringify(result, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  process.stdout.write(result.markdown);
  process.stderr.write(report.stderr);
  process.stderr.write(
    `Offline fixture ready.\n` +
      `Session: ${seeded.sessionId}\n` +
      `Evidence home: ${reset.home}\n` +
      `Report: ${markdownPath}\n` +
      `Report JSON: ${jsonPath}\n` +
      `Open: node ${cliPath} open ${seeded.sessionId} --home ${reset.home}\n`,
  );
} catch (error) {
  process.stderr.write(
    `tekrion offline demo: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
