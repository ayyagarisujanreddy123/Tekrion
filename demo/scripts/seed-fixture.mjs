import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const transcriptPath = join(
  repositoryRoot,
  "demo",
  "transcripts",
  "rogue-session.json",
);

export async function seedFixture(home) {
  const [{ resolveDaemonPaths }, { openTekrionStorage }] = await Promise.all([
    import("../../apps/daemon/dist/index.js"),
    import("../../packages/storage/dist/index.js"),
  ]);
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const paths = resolveDaemonPaths(resolve(home));
  const storage = await openTekrionStorage({
    databasePath: paths.databasePath,
    dataDirectory: paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  try {
    if (storage.sessions.get(transcript.session.id) !== undefined) {
      throw new Error(
        `Session ${transcript.session.id} already exists; run demo:reset first.`,
      );
    }
    storage.transaction(() => {
      storage.sessions.create({
        ...transcript.session,
        counts: {
          events: 0,
          errors: 0,
          inputTokens: null,
          outputTokens: null,
        },
      });
      for (const event of transcript.events) {
        storage.events.insert(event);
      }
      const inserted = storage.sessions.getRequired(transcript.session.id);
      storage.sessions.replace({
        ...inserted,
        endedAt: transcript.session.endedAt,
        status: transcript.session.status,
        counts: {
          ...inserted.counts,
          inputTokens: transcript.session.counts.inputTokens,
          outputTokens: transcript.session.counts.outputTokens,
        },
      });
    });
    return {
      sessionId: transcript.session.id,
      targetEventId: transcript.expectedInvestigation.targetEventId,
      eventCount: transcript.events.length,
      home: paths.homeDirectory,
    };
  } finally {
    storage.close();
  }
}

function homeFrom(argv) {
  if (argv[0] !== "--home" || argv[1] === undefined || argv.length !== 2) {
    throw new Error("Usage: seed-fixture.mjs --home PATH");
  }
  return argv[1];
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await seedFixture(homeFrom(process.argv.slice(2))))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `tekrion demo seed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
