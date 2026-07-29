import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiReportProvider } from "@tekrion/analysis";
import {
  TekrionEventSchema,
  IncidentReportResultSchema,
  RawExchangeSchema,
  SessionSchema,
  type TekrionEvent,
  type Session,
} from "@tekrion/protocol";
import { openTekrionStorage, type TekrionStorage } from "@tekrion/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  TekrionArchiveConflictError,
  TekrionArchiveIntegrityError,
  EvidenceQueryService,
  archiveSha256,
  canonicalJson,
  executeEvidenceDeletion,
  exportTekrionArchive,
  importTekrionArchive,
  planEvidencePrune,
  planSessionDeletion,
  verifyTekrionArchive,
} from "../src/index.js";

const TIME = "2026-07-01T12:00:00.000Z";
const LATER = "2026-07-01T12:01:00.000Z";
const IMPORTED_AT = "2026-07-20T12:00:00.000Z";
const SECRET = "sk-proj-archivefixturesecret1234";
const roots: string[] = [];
const storages: TekrionStorage[] = [];

async function storageRoot(): Promise<TekrionStorage> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-archive-test-"));
  roots.push(root);
  const storage = await openTekrionStorage({
    databasePath: join(root, "tekrion.sqlite"),
    dataDirectory: join(root, "data"),
    recoverIncompleteExchanges: false,
  });
  storages.push(storage);
  return storage;
}

function activeSession(id: string, startedAt = TIME): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    id,
    startedAt,
    status: "active",
    captureLevel: "wrapped-process",
    command: {
      executable: "fixture-agent",
      arguments: [`--api-key=${SECRET}`],
      cwd: "/private/workspace/archive-fixture",
    },
    repoRoot: "/private/workspace/archive-fixture",
    agentName: "fixture-agent",
    models: ["fixture-model"],
    upstreamOrigin: "https://provider.example",
    tags: ["fixture"],
    counts: {
      events: 0,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    },
    metadata: {
      password: "archive-password-value",
      workspaceBaseline: {
        root: "/private/metadata-only-root",
      },
    },
  });
}

function event(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: string;
  readonly summary: Record<string, unknown>;
  readonly payloadRef?: TekrionEvent["payloadRef"];
}): TekrionEvent {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    occurredAt: TIME,
    observedAt: TIME,
    source: input.type.startsWith("file.") ? "filesystem" : "proxy",
    type: input.type,
    evidence: "observed",
    ...(input.payloadRef === undefined ? {} : { payloadRef: input.payloadRef }),
    summary: input.summary,
    redaction: { applied: false, ruleIds: [] },
  });
}

async function seedSession(
  storage: TekrionStorage,
  id = "session-archive-source",
): Promise<void> {
  storage.sessions.create(activeSession(id));
  const payload = await storage.blobs.put(
    `api_key=${SECRET}\nsource payload\n`,
    { mediaType: "text/plain" },
  );
  storage.rawExchanges.insertComplete(
    RawExchangeSchema.parse({
      schemaVersion: 1,
      id: `exchange-${id}`,
      sessionId: id,
      sequence: 1,
      protocol: "openai.responses",
      method: "POST",
      path: "/v1/responses",
      query: {},
      requestHeaders: { "content-type": ["application/json"] },
      requestBodyRef: payload,
      responseStatus: 200,
      responseHeaders: { "content-type": ["application/json"] },
      responseBodyRef: payload,
      startedAt: TIME,
      endedAt: LATER,
      outcome: "completed",
      parseStatus: "parsed",
      capture: {
        requestComplete: true,
        responseComplete: true,
        droppedRequestBytes: 0,
        droppedResponseBytes: 0,
      },
    }),
  );
  storage.events.insert(
    event({
      id: `event-message-${id}`,
      sessionId: id,
      sequence: 1,
      type: "message.user",
      summary: {
        text: `Fix the build; api_key=${SECRET}`,
        cwd: "/private/event-only-cwd",
      },
      payloadRef: payload,
    }),
    {
      rawExchangeId: `exchange-${id}`,
      normalizationVersion: "fixture-normalizer-v1",
    },
  );
  storage.events.insert(
    event({
      id: `event-delete-${id}`,
      sessionId: id,
      sequence: 2,
      type: "file.delete",
      summary: {
        path: "test/math.test.js",
        operation: "delete",
        timingPrecision: "exact-final-diff",
      },
      payloadRef: payload,
    }),
  );
  storage.fileChanges.insert({
    schemaVersion: 1,
    eventId: `event-delete-${id}`,
    path: "test/math.test.js",
    operation: "delete",
    beforeHash: "a".repeat(64),
    patchBlobId: payload.id,
    timingPrecision: "exact-final-diff",
    sensitivity: "normal",
  });
  const current = storage.sessions.getRequired(id);
  storage.sessions.replace({
    ...current,
    endedAt: LATER,
    status: "completed",
  });
}

afterEach(async () => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("TKR archive export and import", () => {
  it("creates a redacted share archive and imports it as immutable evidence", async () => {
    const source = await storageRoot();
    await seedSession(source);
    const report = await new EvidenceQueryService(source, {
      now: () => new Date(LATER),
    }).getReport("session-archive-source");
    const exported = await exportTekrionArchive(source, {
      sessionId: "session-archive-source",
      profile: "share",
      report,
      exportedAt: LATER,
    });

    expect(exported.archive.manifest).toMatchObject({
      profile: "share",
      counts: { events: 2, rawExchanges: 0, blobs: 0, reports: 1 },
      redaction: { applied: true },
    });
    const verifiedShare = verifyTekrionArchive(exported.bytes);
    const archivedReport = IncidentReportResultSchema.parse(
      JSON.parse(
        Buffer.from(
          verifiedShare.entries.get(
            "report/incident-report.json",
          ) as Uint8Array,
        ).toString("utf8"),
      ),
    );
    const decodedShareEntries = [...verifiedShare.entries.values()]
      .map((bytes) => Buffer.from(bytes).toString("utf8"))
      .join("\n");
    expect(decodedShareEntries).not.toContain(SECRET);
    expect(decodedShareEntries).not.toContain("archive-password-value");
    expect(decodedShareEntries).not.toContain(
      "/private/workspace/archive-fixture",
    );
    expect(decodedShareEntries).not.toContain("/private/metadata-only-root");
    expect(decodedShareEntries).not.toContain("/private/event-only-cwd");
    expect(decodedShareEntries).toContain("[REDACTED:secret.openai-api-key]");
    expect(verifiedShare.archive.manifest.archiveId).toBe(
      exported.archive.manifest.archiveId,
    );

    const destination = await storageRoot();
    const imported = await importTekrionArchive(destination, {
      bytes: exported.bytes,
      importedAt: IMPORTED_AT,
    });
    expect(imported).toMatchObject({
      sessionId: "session-archive-source",
      profile: "share",
      readOnly: true,
      eventCount: 2,
      blobCount: 0,
    });
    const importedSession = destination.sessions.getRequired(
      imported.sessionId,
    );
    expect(importedSession).toMatchObject({
      status: "imported-readonly",
      metadata: {
        importedReadOnly: true,
        sourceArchiveId: exported.archive.manifest.archiveId,
      },
    });
    expect(importedSession.command).toBeUndefined();
    expect(importedSession.repoRoot).toBeUndefined();
    const importedEvents = destination.events.list(imported.sessionId).events;
    expect(importedEvents).toHaveLength(2);
    expect(importedEvents[0]?.payloadRef).toBeUndefined();
    expect(JSON.stringify(importedEvents)).not.toContain(SECRET);
    expect(() =>
      destination.events.insert(
        event({
          id: "event-forbidden-import-write",
          sessionId: imported.sessionId,
          sequence: 3,
          type: "tool.call",
          summary: { name: "forbidden" },
        }),
      ),
    ).toThrow("imported session is read-only");
    await expect(
      importTekrionArchive(destination, {
        bytes: exported.bytes,
        importedAt: IMPORTED_AT,
      }),
    ).rejects.toBeInstanceOf(TekrionArchiveConflictError);

    let providerCalled = false;
    const provider: AiReportProvider = {
      provider: "fixture",
      model: "fixture-model",
      analyze: () => {
        providerCalled = true;
        return Promise.reject(new Error("must not run"));
      },
    };
    const query = new EvidenceQueryService(destination, {
      aiReportProvider: provider,
      now: () => new Date(IMPORTED_AT),
    });
    expect(await query.getReport(imported.sessionId)).toEqual(archivedReport);
    const preflight = await query.getReportPreflight(imported.sessionId);
    const result = await query.generateAiReport(imported.sessionId, {
      schemaVersion: 1,
      consent: true,
      consentFingerprintSha256: preflight.consentFingerprintSha256,
    });
    expect(result.aiAttempt).toMatchObject({
      status: "failed",
      externalEvidenceSent: false,
    });
    expect(providerCalled).toBe(false);
  });

  it("round-trips forensic payloads and rejects tampering", async () => {
    const source = await storageRoot();
    await seedSession(source);
    const report = await new EvidenceQueryService(source, {
      now: () => new Date(LATER),
    }).getReport("session-archive-source");
    const exported = await exportTekrionArchive(source, {
      sessionId: "session-archive-source",
      profile: "forensic",
      report,
      exportedAt: LATER,
    });
    expect(exported.archive.manifest.counts.rawExchanges).toBe(1);
    expect(exported.archive.manifest.counts.blobs).toBeGreaterThan(0);
    const verified = verifyTekrionArchive(exported.bytes);
    const payload = verified.entries.get(
      exported.archive.manifest.blobs[0]?.entryPath as string,
    );
    expect(Buffer.from(payload as Uint8Array).toString("utf8")).toContain(
      SECRET,
    );

    const destination = await storageRoot();
    await importTekrionArchive(destination, {
      bytes: exported.bytes,
      importedAt: IMPORTED_AT,
    });
    const raw = destination.rawExchanges.getRequired(
      "exchange-session-archive-source",
    );
    expect(
      Buffer.from(
        await destination.blobs.get(raw.requestBodyRef?.id as string),
      ).toString("utf8"),
    ).toContain(SECRET);

    const tampered = structuredClone(exported.archive);
    const first = tampered.entries[0];
    if (first === undefined) {
      throw new Error("fixture archive has no entries");
    }
    first.data = `${first.data.slice(0, -1)}${first.data.endsWith("A") ? "B" : "A"}`;
    expect(() =>
      verifyTekrionArchive(Buffer.from(JSON.stringify(tampered), "utf8")),
    ).toThrow(TekrionArchiveIntegrityError);

    const manifestTamper = structuredClone(exported.archive);
    manifestTamper.manifest.sourceSessionId = "session-tampered";
    expect(() =>
      verifyTekrionArchive(Buffer.from(JSON.stringify(manifestTamper), "utf8")),
    ).toThrow("manifest digest");

    const semanticTamper = structuredClone(exported.archive);
    const markdownEntry = semanticTamper.entries.find(
      (entry) => entry.path === "report/incident-report.md",
    );
    const markdownDescriptor = semanticTamper.manifest.entries.find(
      (entry) => entry.path === "report/incident-report.md",
    );
    if (markdownEntry === undefined || markdownDescriptor === undefined) {
      throw new Error("fixture report entries are unavailable");
    }
    markdownEntry.data = Buffer.from("different markdown", "utf8").toString(
      "base64",
    );
    markdownDescriptor.byteLength = Buffer.byteLength("different markdown");
    markdownDescriptor.sha256 = archiveSha256("different markdown");
    semanticTamper.manifest.totalBytes = semanticTamper.manifest.entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    semanticTamper.manifestSha256 = archiveSha256(
      canonicalJson(semanticTamper.manifest),
    );
    const semanticDestination = await storageRoot();
    await expect(
      importTekrionArchive(semanticDestination, {
        bytes: Buffer.from(JSON.stringify(semanticTamper), "utf8"),
        importedAt: IMPORTED_AT,
      }),
    ).rejects.toThrow("Markdown report");
  });

  it("imports pre-rebrand blackbox-bbx archives", async () => {
    const source = await storageRoot();
    await seedSession(source);
    const exported = await exportTekrionArchive(source, {
      sessionId: "session-archive-source",
      profile: "share",
      exportedAt: LATER,
    });
    const legacy = structuredClone(exported.archive);
    legacy.manifest.format = "blackbox-bbx";
    legacy.manifestSha256 = archiveSha256(canonicalJson(legacy.manifest));
    const bytes = Buffer.from(`${canonicalJson(legacy)}\n`, "utf8");

    expect(verifyTekrionArchive(bytes).archive.manifest.format).toBe(
      "blackbox-bbx",
    );
    const destination = await storageRoot();
    await expect(
      importTekrionArchive(destination, {
        bytes,
        importedAt: IMPORTED_AT,
      }),
    ).resolves.toMatchObject({
      sessionId: "session-archive-source",
      profile: "share",
      readOnly: true,
    });
  });

  it("preserves an archived session-level report when no action target exists", async () => {
    const source = await storageRoot();
    const sessionId = "session-archive-without-target";
    source.sessions.create(activeSession(sessionId));
    source.events.insert(
      event({
        id: "event-targetless-message",
        sessionId,
        sequence: 1,
        type: "message.user",
        summary: { text: "Explain the current state." },
      }),
    );
    source.sessions.replace({
      ...source.sessions.getRequired(sessionId),
      endedAt: LATER,
      status: "completed",
    });
    const report = await new EvidenceQueryService(source, {
      now: () => new Date(LATER),
    }).getReport(sessionId);
    expect(report.report.targetEventId).toBeUndefined();
    const exported = await exportTekrionArchive(source, {
      sessionId,
      profile: "share",
      report,
      exportedAt: LATER,
    });
    const verified = verifyTekrionArchive(exported.bytes);
    const archivedReport = IncidentReportResultSchema.parse(
      JSON.parse(
        Buffer.from(
          verified.entries.get("report/incident-report.json") as Uint8Array,
        ).toString("utf8"),
      ),
    );

    const destination = await storageRoot();
    await importTekrionArchive(destination, {
      bytes: exported.bytes,
      importedAt: IMPORTED_AT,
    });
    expect(
      await new EvidenceQueryService(destination, {
        now: () => new Date(IMPORTED_AT),
      }).getReport(sessionId),
    ).toEqual(archivedReport);
  });
});

describe("evidence deletion and retention", () => {
  it("previews deletion, removes linked internal sessions, and preserves active evidence", async () => {
    const storage = await storageRoot();
    await seedSession(storage, "session-old");
    storage.sessions.create(
      SessionSchema.parse({
        ...activeSession("session-internal"),
        captureLevel: "api",
        metadata: {
          internalAnalysis: true,
          analysisTargetSessionId: "session-old",
        },
      }),
    );
    const internal = storage.sessions.getRequired("session-internal");
    storage.sessions.replace({
      ...internal,
      endedAt: LATER,
      status: "completed",
    });
    storage.sessions.create(activeSession("session-active", IMPORTED_AT));

    const deletion = planSessionDeletion(storage, "session-old");
    expect(deletion.sessions.map((item) => item.sessionId)).toEqual([
      "session-internal",
      "session-old",
    ]);
    expect(storage.sessions.get("session-old")).toBeDefined();
    const deleted = await executeEvidenceDeletion(storage, deletion);
    expect(deleted.deletedSessionIds).toEqual([
      "session-internal",
      "session-old",
    ]);
    expect(storage.sessions.get("session-old")).toBeUndefined();
    expect(storage.sessions.get("session-active")?.status).toBe("active");
    expect(deleted.garbageCollection.removedBlobs).toBeGreaterThan(0);

    const constrained = planEvidencePrune(storage, { maximumBytes: 0 });
    expect(constrained.satisfied).toBe(false);
    expect(constrained.sessions).toHaveLength(0);
  });
});
