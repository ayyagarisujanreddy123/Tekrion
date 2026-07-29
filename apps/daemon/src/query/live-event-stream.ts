import type { IncomingMessage, ServerResponse } from "node:http";

import { LiveEventReadySchema, type TekrionEvent } from "@tekrion/protocol";
import { z } from "zod";

import type { EvidenceQueryService } from "./evidence-query-service.js";
import { beginEventStream } from "./http-response.js";

const LiveEventStreamConfigurationSchema = z
  .object({
    maximumConnections: z.number().int().min(1).max(256).default(32),
    batchSize: z.number().int().min(1).max(1000).default(100),
    pollIntervalMilliseconds: z.number().int().min(5).max(10_000).default(200),
    heartbeatMilliseconds: z
      .number()
      .int()
      .min(50)
      .max(120_000)
      .default(15_000),
    writeTimeoutMilliseconds: z
      .number()
      .int()
      .min(50)
      .max(120_000)
      .default(5_000),
    retryMilliseconds: z.number().int().min(100).max(60_000).default(1_000),
  })
  .strict();

export type LiveEventStreamConfiguration = z.input<
  typeof LiveEventStreamConfigurationSchema
>;

export class LiveEventStreamCapacityError extends Error {
  constructor(readonly maximumConnections: number) {
    super(`The live event stream limit of ${maximumConnections} is active.`);
    this.name = "LiveEventStreamCapacityError";
  }
}

function eventFrame(event: TekrionEvent): string {
  return `id: ${event.sequence}\nevent: tekrion.event\ndata: ${JSON.stringify(event)}\n\n`;
}

function readyFrame(sessionId: string, afterSequence: number): string {
  const ready = LiveEventReadySchema.parse({
    schemaVersion: 1,
    sessionId,
    afterSequence,
  });
  return `event: tekrion.ready\ndata: ${JSON.stringify(ready)}\n\n`;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function writeBounded(
  response: ServerResponse,
  frame: string,
  timeoutMilliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  if (response.write(frame)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      response.destroy();
      finish(false);
    }, timeoutMilliseconds);
    timer.unref();
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    signal.addEventListener("abort", onClose, { once: true });

    function onDrain(): void {
      finish(true);
    }

    function onClose(): void {
      finish(false);
    }

    function finish(writable: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      signal.removeEventListener("abort", onClose);
      resolve(writable);
    }
  });
}

export class LiveEventStreamer {
  private readonly configuration: z.output<
    typeof LiveEventStreamConfigurationSchema
  >;
  private activeConnectionsValue = 0;

  constructor(
    private readonly query: EvidenceQueryService,
    configuration: LiveEventStreamConfiguration = {},
  ) {
    this.configuration =
      LiveEventStreamConfigurationSchema.parse(configuration);
  }

  get activeConnections(): number {
    return this.activeConnectionsValue;
  }

  async stream(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
    afterSequence: number,
  ): Promise<void> {
    this.query.getSession(sessionId);
    if (this.activeConnectionsValue >= this.configuration.maximumConnections) {
      throw new LiveEventStreamCapacityError(
        this.configuration.maximumConnections,
      );
    }

    this.activeConnectionsValue += 1;
    const abort = new AbortController();
    const close = () => abort.abort();
    request.once("aborted", close);
    response.once("close", close);
    beginEventStream(response);

    try {
      let cursor = afterSequence;
      let heartbeatAt = Date.now() + this.configuration.heartbeatMilliseconds;
      if (
        !(await writeBounded(
          response,
          `retry: ${this.configuration.retryMilliseconds}\n${readyFrame(sessionId, cursor)}`,
          this.configuration.writeTimeoutMilliseconds,
          abort.signal,
        ))
      ) {
        return;
      }

      while (!abort.signal.aborted) {
        const events = this.query.listEventsAfterSequence(
          sessionId,
          cursor,
          this.configuration.batchSize,
        );
        for (const event of events) {
          if (
            !(await writeBounded(
              response,
              eventFrame(event),
              this.configuration.writeTimeoutMilliseconds,
              abort.signal,
            ))
          ) {
            return;
          }
          cursor = event.sequence;
        }
        if (events.length === this.configuration.batchSize) {
          continue;
        }

        const now = Date.now();
        if (now >= heartbeatAt) {
          if (
            !(await writeBounded(
              response,
              `: keepalive ${now}\n\n`,
              this.configuration.writeTimeoutMilliseconds,
              abort.signal,
            ))
          ) {
            return;
          }
          heartbeatAt = now + this.configuration.heartbeatMilliseconds;
        }
        await abortableDelay(
          Math.min(
            this.configuration.pollIntervalMilliseconds,
            Math.max(1, heartbeatAt - Date.now()),
          ),
          abort.signal,
        );
      }
    } finally {
      request.off("aborted", close);
      response.off("close", close);
      this.activeConnectionsValue -= 1;
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }
}
