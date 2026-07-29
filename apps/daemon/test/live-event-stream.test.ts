import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TekrionEventSchema,
  SessionSchema,
  type TekrionEvent,
  type Session,
} from "@tekrion/protocol";
import { openTekrionStorage, type TekrionStorage } from "@tekrion/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  ControlServer,
  EvidenceQueryService,
  type DaemonStatus,
} from "../src/index.js";

interface SseFrame {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

const TOKEN = "b".repeat(43);
const TIME = "2026-07-16T12:00:00.000Z";
const roots: string[] = [];
const storages: TekrionStorage[] = [];
const controls: ControlServer[] = [];
const clients: ClientRequest[] = [];

function fixtureStatus(): DaemonStatus {
  return {
    schemaVersion: 1,
    instanceId: "daemon-live-fixture",
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

function session(): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    id: "session-live",
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

function event(sequence: number): TekrionEvent {
  return TekrionEventSchema.parse({
    schemaVersion: 1,
    id: `event-live-${sequence}`,
    sessionId: "session-live",
    sequence,
    occurredAt: TIME,
    observedAt: TIME,
    source: "process",
    type: "process.output",
    evidence: "observed",
    summary: { stream: "stdout", text: `frame ${sequence}` },
    redaction: { applied: false, ruleIds: [] },
  });
}

async function testStorage(): Promise<TekrionStorage> {
  const root = await mkdtemp(join(tmpdir(), "tekrion-live-api-test-"));
  roots.push(root);
  const storage = await openTekrionStorage({
    databasePath: join(root, "tekrion.sqlite"),
    dataDirectory: join(root, "data"),
    recoverIncompleteExchanges: false,
  });
  storages.push(storage);
  return storage;
}

async function secondConnection(
  storage: TekrionStorage,
): Promise<TekrionStorage> {
  const second = await openTekrionStorage({
    databasePath: storage.databasePath,
    dataDirectory: storage.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  storages.push(second);
  return second;
}

async function startControl(
  storage: TekrionStorage,
  maximumConnections = 2,
): Promise<string> {
  const control = new ControlServer({
    token: TOKEN,
    listenPort: 0,
    status: fixtureStatus,
    shutdown: () => undefined,
    query: new EvidenceQueryService(storage),
    liveQuery: {
      maximumConnections,
      batchSize: 1,
      pollIntervalMilliseconds: 5,
      heartbeatMilliseconds: 50,
      writeTimeoutMilliseconds: 250,
      retryMilliseconds: 100,
    },
  });
  controls.push(control);
  return (await control.start()).origin;
}

function parseFrame(block: string): SseFrame | undefined {
  let eventName = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const raw = separator === -1 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") {
      eventName = value;
    } else if (field === "id") {
      id = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return {
    event: eventName,
    ...(id === undefined ? {} : { id }),
    data: data.join("\n"),
  };
}

class SseClient {
  private buffer = "";
  private readonly frames: SseFrame[] = [];
  private readonly changed = new Set<() => void>();

  constructor(
    readonly request: ClientRequest,
    readonly response: IncomingMessage,
  ) {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.buffer += chunk.replaceAll("\r\n", "\n");
      let boundary = this.buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseFrame(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary + 2);
        if (frame !== undefined) {
          this.frames.push(frame);
          for (const notify of this.changed) {
            notify();
          }
        }
        boundary = this.buffer.indexOf("\n\n");
      }
    });
  }

  async next(
    predicate: (frame: SseFrame) => boolean,
    timeoutMilliseconds = 2_000,
  ): Promise<SseFrame> {
    const take = (): SseFrame | undefined => {
      const index = this.frames.findIndex(predicate);
      if (index < 0) {
        return undefined;
      }
      return this.frames.splice(index, 1)[0];
    };
    const existing = take();
    if (existing !== undefined) {
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), timeoutMilliseconds);
      const notify = () => {
        const frame = take();
        if (frame !== undefined) {
          finish(frame);
        }
      };
      this.changed.add(notify);

      const finish = (frame?: SseFrame) => {
        clearTimeout(timer);
        this.changed.delete(notify);
        if (frame === undefined) {
          reject(new Error("SSE frame was not received before timeout."));
        } else {
          resolve(frame);
        }
      };
    });
  }

  close(): void {
    this.request.destroy();
  }
}

async function openSse(
  origin: string,
  path: string,
  lastEventId?: string,
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(lastEventId === undefined
            ? {}
            : { "last-event-id": lastEventId }),
        },
      },
      (response) => resolve(new SseClient(request, response)),
    );
    clients.push(request);
    request.on("error", (error) => {
      if (!request.destroyed) {
        reject(error);
      }
    });
    request.end();
  });
}

async function requestOnce(
  origin: string,
  path: string,
  options: {
    readonly authenticated?: boolean;
    readonly lastEventId?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        headers: {
          ...(options.authenticated === false
            ? {}
            : { authorization: `Bearer ${TOKEN}` }),
          ...(options.lastEventId === undefined
            ? {}
            : { "last-event-id": options.lastEventId }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  for (const control of controls.splice(0)) {
    await control.close(100);
  }
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("live event stream", () => {
  it("catches up, observes another writer, and resumes after the last sequence", async () => {
    const storage = await testStorage();
    storage.sessions.create(session());
    storage.events.insert(event(1));
    const writer = await secondConnection(storage);
    const origin = await startControl(storage);

    const initial = await openSse(origin, "/v1/sessions/session-live/live");
    expect(initial.response.statusCode).toBe(200);
    expect(initial.response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(initial.response.headers["cache-control"]).toContain("no-transform");
    expect(initial.response.headers["x-content-type-options"]).toBe("nosniff");
    expect(
      JSON.parse(
        (await initial.next((frame) => frame.event === "tekrion.ready")).data,
      ),
    ).toMatchObject({
      sessionId: "session-live",
      afterSequence: 0,
    });
    const first = await initial.next(
      (frame) => frame.event === "tekrion.event",
    );
    expect(first.id).toBe("1");
    expect(JSON.parse(first.data)).toMatchObject({ id: "event-live-1" });

    writer.events.insert(event(2));
    const second = await initial.next(
      (frame) => frame.event === "tekrion.event",
    );
    expect(second.id).toBe("2");
    expect(JSON.parse(second.data)).toMatchObject({ id: "event-live-2" });
    initial.close();

    writer.events.insert(event(3));
    const resumed = await openSse(
      origin,
      "/v1/sessions/session-live/live",
      "2",
    );
    expect(
      JSON.parse(
        (await resumed.next((frame) => frame.event === "tekrion.ready")).data,
      ),
    ).toMatchObject({
      afterSequence: 2,
    });
    const third = await resumed.next(
      (frame) => frame.event === "tekrion.event",
    );
    expect(third.id).toBe("3");
    expect(JSON.parse(third.data)).toMatchObject({ id: "event-live-3" });
    resumed.close();
  });

  it("authenticates recovery cursors and bounds concurrent fan-out", async () => {
    const storage = await testStorage();
    storage.sessions.create(session());
    const origin = await startControl(storage, 1);
    const active = await openSse(origin, "/v1/sessions/session-live/live");
    await active.next((frame) => frame.event === "tekrion.ready");

    expect(
      (
        await requestOnce(origin, "/v1/sessions/session-live/live", {
          authenticated: false,
        })
      ).status,
    ).toBe(401);
    const saturated = await requestOnce(
      origin,
      "/v1/sessions/session-live/live",
    );
    expect(saturated.status).toBe(503);
    expect(JSON.parse(saturated.body)).toEqual({
      error: "stream_capacity_exceeded",
    });
    expect(saturated.headers["retry-after"]).toBe("1");
    expect(
      (
        await requestOnce(origin, "/v1/sessions/session-live/live?after=1", {
          lastEventId: "2",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await requestOnce(origin, "/v1/sessions/session-live/live", {
          lastEventId: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (await requestOnce(origin, "/v1/sessions/missing/live")).status,
    ).toBe(404);
    active.close();
  });
});
