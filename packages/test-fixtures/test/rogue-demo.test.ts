import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  BlackBoxEventSchema,
  SessionSchema,
} from "../../protocol/src/index.js";

interface RogueTranscript {
  readonly session: unknown;
  readonly events: readonly unknown[];
  readonly expectedInvestigation: {
    readonly targetEventId: string;
    readonly topCandidateEventId: string;
  };
}

const transcriptUrl = new URL(
  "../../../demo/transcripts/rogue-session.json",
  import.meta.url,
);
const readmeUrl = new URL(
  "../../../demo/rogue-repo-template/README.md",
  import.meta.url,
);
const testFileUrl = new URL(
  "../../../demo/rogue-repo-template/test/math.test.js",
  import.meta.url,
);
const resetScriptUrl = new URL(
  "../../../demo/scripts/reset.mjs",
  import.meta.url,
);
const resetScriptPath = fileURLToPath(resetScriptUrl);
const execute = promisify(execFile);

async function loadTranscript(): Promise<RogueTranscript> {
  const contents = await readFile(transcriptUrl, "utf8");
  return JSON.parse(contents) as RogueTranscript;
}

describe("deterministic rogue demo fixture", () => {
  it("ships with the test file intact", async () => {
    await expect(readFile(testFileUrl, "utf8")).resolves.toContain(
      "adds two numbers",
    );
  });

  it("contains valid session and canonical event contracts", async () => {
    const transcript = await loadTranscript();

    expect(SessionSchema.safeParse(transcript.session).success).toBe(true);
    expect(transcript.events).toHaveLength(9);

    for (const event of transcript.events) {
      expect(BlackBoxEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("links the exact poisoned line to a later deletion target", async () => {
    const transcript = await loadTranscript();
    const events = transcript.events.map((event) =>
      BlackBoxEventSchema.parse(event),
    );
    const readResult = events.find(
      (event) =>
        event.id === transcript.expectedInvestigation.topCandidateEventId,
    );
    const deletion = events.find(
      (event) => event.id === transcript.expectedInvestigation.targetEventId,
    );
    const readmeLines = (await readFile(readmeUrl, "utf8")).split("\n");

    expect(readResult).toBeDefined();
    expect(deletion).toBeDefined();
    expect(readResult?.sequence).toBeLessThan(deletion?.sequence ?? 0);
    expect(readResult?.summary.content).toBe(readmeLines[6]);
    expect(deletion?.type).toBe("file.delete");
    expect(deletion?.summary.path).toBe("test/math.test.js");
  });

  it("resets and cleans the offline demo repeatedly", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "blackbox-demo-reset-test-"),
    );
    try {
      for (let run = 0; run < 2; run += 1) {
        const result = await execute(
          process.execPath,
          [resetScriptPath, "--output", outputRoot],
          { encoding: "utf8" },
        );
        expect(JSON.parse(result.stdout)).toMatchObject({
          outputRoot,
          cleaned: false,
        });
        await expect(
          readFile(
            join(outputRoot, "rogue-repo", "test", "math.test.js"),
            "utf8",
          ),
        ).resolves.toContain("adds two numbers");
        await expect(
          stat(join(outputRoot, "rogue-repo", ".git")),
        ).resolves.toMatchObject({});
      }
      const cleaned = await execute(
        process.execPath,
        [resetScriptPath, "--output", outputRoot, "--clean"],
        { encoding: "utf8" },
      );
      expect(JSON.parse(cleaned.stdout)).toMatchObject({ cleaned: true });
      await expect(stat(outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to reset a directory that is not explicitly demo-scoped", async () => {
    const unsafeRoot = await mkdtemp(join(tmpdir(), "unsafe-reset-target-"));
    const markerPath = join(unsafeRoot, "must-survive.txt");
    await writeFile(markerPath, "preserved\n");
    try {
      await expect(
        execute(
          process.execPath,
          [resetScriptPath, "--output", unsafeRoot, "--clean"],
          { encoding: "utf8" },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Demo output must be a dedicated directory",
        ),
      });
      await expect(readFile(markerPath, "utf8")).resolves.toBe("preserved\n");
    } finally {
      await rm(unsafeRoot, { recursive: true, force: true });
    }
  });
});
