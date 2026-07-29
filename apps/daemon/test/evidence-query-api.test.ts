import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AiReportProvider,
  AiReportProviderRequest,
} from "@tekrion/analysis";
import {
  TekrionEventSchema,
  RawExchangeSchema,
  SessionSchema,
  type TekrionEvent,
  type BlobReference,
  type Session,
} from "@tekrion/protocol";
import { openTekrionStorage, type TekrionStorage } from "@tekrion/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlServer,
  EvidenceQueryService,
  type DaemonStatus,
} from "../src/index.js";

interface HttpResult {
  readonly status: number;
  readonly body: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
}

const TOKEN = "a".repeat(43);
const TIME = "2026-07-16T12:00:00.000Z";
const LATER = "2026-07-16T12:00:01.000Z";
const roots: string[] = [];
const storages: TekrionStorage[] = [];
const controls: ControlServer[] = [];

function fixtureStatus(): DaemonStatus {
  return {
    schemaVersion: 1,
    instanceId: "daemon-query-fixture",
    pid: process.pid,
    state: "ready",
    startedAt: TIME,
    proxyOrigin: "http://127.0.0.1:4141",
    controlOrigin: "http://127.0.0.1:4142",
    proxy: {
      status: "healthy",
      activeRequests: 0,
      requestsStarted: 0,
      requestsCompleted: 0,
      captureFailures: 0,
      normalizationFailures: 0,
      droppedCaptureBytes: 0,
      droppedManifestEntries: 0,
      clientDisconnects: 0,
      upstreamFailures: 0,
    },
    storage: {
      schemaVersion: 1,
      readOnly: false,
      recoveredIncompleteExchanges: 0,
      removedTemporaryBlobs: 0,
    },
  };
}

function session(id = "session-query"): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    id,
    startedAt: TIME,
    status: "active",
    captureLevel: "wrapped-process",
    models: [],
    tags: [],
    counts: {
      events: 0,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    },
    metadata: {},
  });
}

function event(input: {
  readonly id: string;
  readonly sequence: number;
  readonly source: "proxy" | "filesystem";
  readonly type: string;
  readonly summary: Record<string, unknown>;
  readonly payloadRef?: BlobReference;
}): TekrionEvent {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id: input.id,
    sessionId: "session-query",
    sequence: input.sequence,
    occurredAt: input.sequence === 1 ? TIME : LATER,
    observedAt: input.sequence === 1 ? TIME : LATER,
    source: input.source,
    type: input.type,
    evidence: "observed",
    summary: input.summary,
    ...(input.payloadRef === undefined ? {} : { payloadRef: input.payloadRef }),
    redaction: { applied: false, ruleIds: [] },
  });
}

async function testStorage(): Promise<TekrionStorage> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-query-api-test-"));
  roots.push(root);
  const storage = await openTekrionStorage({
    databasePath: join(root, "tekrion.sqlite"),
    dataDirectory: join(root, "data"),
    recoverIncompleteExchanges: false,
  });
  storages.push(storage);
  return storage;
}

async function startControl(
  storage: TekrionStorage,
  maximumQueryPayloadBytes = 64 * 1024 * 1024,
  aiReportProvider?: AiReportProvider,
): Promise<string> {
  const control = new ControlServer({
    token: TOKEN,
    listenPort: 0,
    status: fixtureStatus,
    shutdown: () => undefined,
    query: new EvidenceQueryService(storage, {
      ...(aiReportProvider === undefined ? {} : { aiReportProvider }),
    }),
    maximumQueryPayloadBytes,
  });
  controls.push(control);
  return (await control.start()).origin;
}

async function get(
  origin: string,
  path: string,
  options: {
    readonly authenticated?: boolean;
    readonly method?: string;
    readonly origin?: string;
    readonly body?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const request = httpRequest(
      new URL(path, origin),
      {
        method: options.method ?? "GET",
        headers: {
          ...(options.authenticated === false
            ? {}
            : { authorization: `Bearer ${TOKEN}` }),
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(body.length === 0 ? {} : { "content-type": "application/json" }),
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function json(result: HttpResult): unknown {
  return JSON.parse(result.body.toString("utf8"));
}

function reportProvider(): {
  readonly provider: AiReportProvider;
  readonly requests: AiReportProviderRequest[];
} {
  const requests: AiReportProviderRequest[] = [];
  return {
    requests,
    provider: {
      provider: "fixture-provider",
      model: "fixture-model",
      analyze: vi.fn(async (request: AiReportProviderRequest) => {
        requests.push(request);
        const snapshot = JSON.parse(request.evidenceSnapshot) as {
          readonly categories: readonly {
            readonly evidence: readonly {
              readonly eventId: string;
              readonly excerpt: string;
            }[];
          }[];
        };
        const evidence = snapshot.categories
          .flatMap((category) => category.evidence)
          .find((item) => item.eventId === "event-file");
        if (evidence === undefined) {
          throw new Error("Expected target evidence was not transmitted.");
        }
        const citation = {
          eventId: evidence.eventId,
          excerpt: evidence.excerpt,
        };
        return {
          output: {
            schemaVersion: 1,
            impact: { statement: "README.md changed.", citations: [citation] },
            rootCauseHypothesis: {
              statement: "The recorded action may explain the change.",
              confidence: "low",
              citations: [citation],
            },
            contributingConditions: [],
            counterevidence: [],
            alternatives: [],
            preventionActions: [],
            limitations: [],
          },
        };
      }),
    },
  };
}

afterEach(async () => {
  for (const control of controls.splice(0)) {
    await control.close();
  }
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("authenticated evidence query API", () => {
  it("serves session, timeline, file, event, search, and health views", async () => {
    const storage = await testStorage();
    storage.sessions.create(session());
    storage.events.insert(
      event({
        id: "event-message",
        sequence: 1,
        source: "proxy",
        type: "message.assistant",
        summary: { text: "needle response from the model" },
      }),
    );
    storage.events.insert(
      event({
        id: "event-file",
        sequence: 2,
        source: "filesystem",
        type: "file.modify",
        summary: {
          path: "README.md",
          operation: "modify",
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
          beforeByteLength: 10,
          afterByteLength: 20,
          timingPrecision: "exact-final-diff",
          sensitivity: "normal",
          payloadKind: "file-delta",
        },
      }),
    );
    const requestBodyRef = await storage.blobs.put(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.2",
          messages: [{ role: "user", content: "What changed?" }],
        }),
        "utf8",
      ),
      { mediaType: "application/json" },
    );
    storage.rawExchanges.insertComplete(
      RawExchangeSchema.parse({
        schemaVersion: 1,
        id: "exchange-context-api",
        sessionId: "session-query",
        sequence: 3,
        protocol: "openai.chat-completions",
        method: "POST",
        path: "/v1/chat/completions",
        query: {},
        requestHeaders: { "content-type": ["application/json"] },
        requestBodyRef,
        responseStatus: 200,
        responseHeaders: { "content-type": ["application/json"] },
        startedAt: TIME,
        endedAt: LATER,
        outcome: "completed",
        parseStatus: "pending",
        capture: {
          requestComplete: true,
          responseComplete: true,
          droppedRequestBytes: 0,
          droppedResponseBytes: 0,
        },
      }),
    );
    storage.events.insertNormalization({
      exchangeId: "exchange-context-api",
      parserVersion: "context-api-test-v1",
      events: [
        event({
          id: "event-context-request",
          sequence: 3,
          source: "proxy",
          type: "model.request",
          summary: { endpoint: "/v1/chat/completions" },
        }),
      ],
    });
    const origin = await startControl(storage);

    expect(
      (await get(origin, "/v1/sessions", { authenticated: false })).status,
    ).toBe(401);
    expect(
      (
        await get(origin, "/v1/sessions", {
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);

    const health = await get(origin, "/v1/health");
    expect(health.status).toBe(200);
    expect(json(health)).toMatchObject({
      instanceId: "daemon-query-fixture",
      state: "ready",
    });

    const sessions = await get(origin, "/v1/sessions?limit=1");
    expect(sessions.status).toBe(200);
    expect(json(sessions)).toMatchObject({
      schemaVersion: 1,
      sessions: [{ id: "session-query" }],
    });

    expect(json(await get(origin, "/v1/sessions/session-query"))).toMatchObject(
      { session: { id: "session-query" } },
    );
    expect(
      json(
        await get(
          origin,
          "/v1/sessions/session-query/events?source=filesystem",
        ),
      ),
    ).toMatchObject({ events: [{ id: "event-file" }] });
    expect(
      json(await get(origin, "/v1/sessions/session-query/files?limit=1")),
    ).toMatchObject({
      changes: [
        {
          event: { id: "event-file" },
          change: { path: "README.md", operation: "modify" },
        },
      ],
    });
    expect(json(await get(origin, "/v1/events/event-file"))).toMatchObject({
      event: { id: "event-file" },
      fileChange: { path: "README.md", operation: "modify" },
    });
    const context = await get(
      origin,
      "/v1/events/event-context-request/context",
    );
    expect(context.status).toBe(200);
    expect(json(context)).toMatchObject({
      requestEventId: "event-context-request",
      completeness: "exact-client-request",
      items: [{ kind: "message", role: "user" }, { kind: "settings" }],
    });
    expect(
      (
        await get(origin, "/v1/events/event-context-request/context", {
          authenticated: false,
        })
      ).status,
    ).toBe(401);
    expect((await get(origin, "/v1/events/event-file/context")).status).toBe(
      400,
    );
    const blame = await get(origin, "/v1/events/event-file/blame");
    expect(blame.status).toBe(200);
    expect(json(blame)).toMatchObject({
      schemaVersion: 1,
      blame: { target: { eventId: "event-file", verb: "modify" } },
      anomalies: { targetEventId: "event-file" },
    });
    expect(
      (
        await get(origin, "/v1/events/event-file/blame", {
          authenticated: false,
        })
      ).status,
    ).toBe(401);
    expect((await get(origin, "/v1/events/event-message/blame")).status).toBe(
      400,
    );
    expect(
      json(
        await get(
          origin,
          "/v1/sessions/session-query/search?q=needle%20response",
        ),
      ),
    ).toMatchObject({
      query: "needle response",
      events: [{ id: "event-message" }],
    });
  });

  it("requires authenticated explicit consent for optional AI reports", async () => {
    const storage = await testStorage();
    storage.sessions.create(session());
    storage.events.insert(
      event({
        id: "event-file",
        sequence: 2,
        source: "filesystem",
        type: "file.modify",
        summary: {
          path: "README.md",
          operation: "modify",
          timingPrecision: "exact-final-diff",
          sensitivity: "normal",
        },
      }),
    );
    const fixture = reportProvider();
    const origin = await startControl(
      storage,
      64 * 1024 * 1024,
      fixture.provider,
    );

    expect(
      (
        await get(origin, "/v1/sessions/session-query/report", {
          authenticated: false,
        })
      ).status,
    ).toBe(401);
    const deterministic = await get(
      origin,
      "/v1/sessions/session-query/report?target_event_id=event-file",
    );
    expect(deterministic.status).toBe(200);
    expect(json(deterministic)).toMatchObject({
      requestedMode: "deterministic",
      report: {
        targetEventId: "event-file",
        analysis: { mode: "deterministic", externalEvidenceSent: false },
      },
    });

    const preflight = await get(
      origin,
      "/v1/sessions/session-query/report/preflight?target_event_id=event-file",
    );
    expect(preflight.status).toBe(200);
    expect(json(preflight)).toMatchObject({
      sessionId: "session-query",
      targetEventId: "event-file",
      provider: "fixture-provider",
      model: "fixture-model",
    });
    const consentFingerprintSha256 = (
      json(preflight) as { consentFingerprintSha256: string }
    ).consentFingerprintSha256;
    expect(fixture.requests).toHaveLength(0);

    const wrongMethod = await get(
      origin,
      "/v1/sessions/session-query/report/ai",
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("POST");
    expect(
      (
        await get(origin, "/v1/sessions/session-query/report/ai", {
          method: "POST",
          authenticated: false,
          body: JSON.stringify({ schemaVersion: 1, consent: true }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await get(origin, "/v1/sessions/session-query/report/ai", {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 1, consent: false }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await get(origin, "/v1/sessions/session-query/report/ai", {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 1, consent: true }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await get(origin, "/v1/sessions/session-query/report/ai", {
          method: "POST",
          body: JSON.stringify({ evidence: "x".repeat(17 * 1024) }),
        })
      ).status,
    ).toBe(400);
    expect(fixture.requests).toHaveLength(0);

    const enriched = await get(origin, "/v1/sessions/session-query/report/ai", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        consent: true,
        consentFingerprintSha256,
        targetEventId: "event-file",
      }),
    });
    expect(enriched.status).toBe(200);
    expect(json(enriched)).toMatchObject({
      requestedMode: "ai",
      report: {
        targetEventId: "event-file",
        analysis: {
          mode: "ai-enriched",
          externalEvidenceSent: true,
          provider: "fixture-provider",
        },
      },
      aiAttempt: { status: "completed" },
    });
    expect(fixture.requests).toHaveLength(1);
  });

  it("returns captured payload bytes with an inert download policy", async () => {
    const storage = await testStorage();
    const captured = Buffer.from(
      "<!doctype html><script>globalThis.compromised = true</script>",
      "utf8",
    );
    const reference = await storage.blobs.put(captured, {
      mediaType: "text/html",
    });
    const origin = await startControl(storage, 64);

    const result = await get(origin, `/v1/payloads/${reference.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(captured);
    expect(result.headers["content-type"]).toBe("application/octet-stream");
    expect(result.headers["content-disposition"]).toBe(
      'attachment; filename="tekrion-payload.bin"',
    );
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(result.headers["x-tekrion-sha256"]).toBe(reference.sha256);
  });

  it("rejects malformed queries and bounds payload reads", async () => {
    const storage = await testStorage();
    storage.sessions.create(session());
    const oversized = await storage.blobs.put(Buffer.alloc(65, 7), {
      mediaType: "application/octet-stream",
    });
    const origin = await startControl(storage, 64);

    expect((await get(origin, "/v1/sessions", { method: "POST" })).status).toBe(
      405,
    );
    expect((await get(origin, "/v1/sessions?unknown=true")).status).toBe(400);
    expect((await get(origin, "/v1/sessions?limit=1&limit=2")).status).toBe(
      400,
    );
    expect(
      (await get(origin, "/v1/sessions/session-query/events?source=untrusted"))
        .status,
    ).toBe(400);
    expect(
      (await get(origin, "/v1/sessions/session-query/search")).status,
    ).toBe(400);
    expect((await get(origin, "/v1/events/event-missing")).status).toBe(404);
    expect(
      (await get(origin, "/v1/sessions/session-query/unknown")).status,
    ).toBe(404);
    const unavailable = await get(origin, `/v1/payloads/${oversized.id}`);
    expect(unavailable.status).toBe(413);
    expect(json(unavailable)).toMatchObject({ error: "payload_unavailable" });
  });
});
