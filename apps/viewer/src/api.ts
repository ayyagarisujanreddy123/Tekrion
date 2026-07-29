import {
  TekrionEventSchema,
  BlameAnalysisSchema,
  ContextResultSchema,
  EventDetailSchema,
  EventPageSchema,
  EventSearchResultSchema,
  FileChangePageSchema,
  IncidentReportResultSchema,
  LiveEventReadySchema,
  ReportPreflightSchema,
  SessionDetailSchema,
  SessionPageSchema,
  type TekrionEvent,
  type BlameAnalysis,
  type ContextResult,
  type EventDetail,
  type EventPage,
  type EventSearchResult,
  type FileChangePage,
  type IncidentReportResult,
  type ReportPreflight,
  type SessionDetail,
  type SessionPage,
} from "@tekrion/protocol";

export interface ParsedServerEvent {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
}

export interface LiveEventHandlers {
  readonly onReady?: (afterSequence: number) => void;
  readonly onEvent: (event: TekrionEvent) => void;
}

interface Schema<T> {
  readonly parse: (value: unknown) => T;
}

export class ViewerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(status === 0 ? code : `Tekrion API returned HTTP ${status}: ${code}`);
    this.name = "ViewerApiError";
  }
}

function appendParameter(
  parameters: URLSearchParams,
  name: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) {
    parameters.set(name, String(value));
  }
}

function parseEventBlock(block: string): ParsedServerEvent | undefined {
  let eventName = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
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

export async function* parseServerEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedServerEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let trailingCarriageReturn = false;
  try {
    while (true) {
      const result = await reader.read();
      let decoded: string = `${trailingCarriageReturn ? "\r" : ""}${decoder.decode(result.value, { stream: !result.done })}`;
      trailingCarriageReturn = !result.done && decoded.endsWith("\r");
      if (trailingCarriageReturn) {
        decoded = decoded.slice(0, -1);
      }
      buffer += decoded.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseEventBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== undefined) {
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (result.done) {
        if (trailingCarriageReturn) {
          buffer += "\n";
        }
        const event = parseEventBlock(buffer);
        if (event !== undefined) {
          yield event;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class ViewerApiClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.baseUrl = new URL(baseUrl);
  }

  listSessions(
    input: {
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): Promise<SessionPage> {
    const parameters = new URLSearchParams();
    appendParameter(parameters, "limit", input.limit);
    appendParameter(parameters, "cursor", input.cursor);
    return this.getJson(
      `/v1/sessions?${parameters.toString()}`,
      SessionPageSchema,
    );
  }

  getSession(sessionId: string): Promise<SessionDetail> {
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      SessionDetailSchema,
    );
  }

  listEvents(
    sessionId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<EventPage> {
    const parameters = new URLSearchParams();
    appendParameter(parameters, "limit", input.limit);
    appendParameter(parameters, "cursor", input.cursor);
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?${parameters.toString()}`,
      EventPageSchema,
    );
  }

  getEvent(eventId: string): Promise<EventDetail> {
    return this.getJson(
      `/v1/events/${encodeURIComponent(eventId)}`,
      EventDetailSchema,
    );
  }

  getContext(eventId: string): Promise<ContextResult> {
    return this.getJson(
      `/v1/events/${encodeURIComponent(eventId)}/context`,
      ContextResultSchema,
    );
  }

  getBlame(eventId: string): Promise<BlameAnalysis> {
    return this.getJson(
      `/v1/events/${encodeURIComponent(eventId)}/blame`,
      BlameAnalysisSchema,
    );
  }

  getReport(
    sessionId: string,
    targetEventId?: string,
  ): Promise<IncidentReportResult> {
    const parameters = new URLSearchParams();
    appendParameter(parameters, "target_event_id", targetEventId);
    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/report${suffix}`,
      IncidentReportResultSchema,
    );
  }

  getReportPreflight(
    sessionId: string,
    targetEventId?: string,
  ): Promise<ReportPreflight> {
    const parameters = new URLSearchParams();
    appendParameter(parameters, "target_event_id", targetEventId);
    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/report/preflight${suffix}`,
      ReportPreflightSchema,
    );
  }

  enrichReport(
    sessionId: string,
    consentFingerprintSha256: string,
    targetEventId?: string,
  ): Promise<IncidentReportResult> {
    return this.postJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/report/ai`,
      {
        schemaVersion: 1,
        consent: true,
        consentFingerprintSha256,
        ...(targetEventId === undefined ? {} : { targetEventId }),
      },
      IncidentReportResultSchema,
    );
  }

  listFileChanges(
    sessionId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<FileChangePage> {
    const parameters = new URLSearchParams();
    appendParameter(parameters, "limit", input.limit);
    appendParameter(parameters, "cursor", input.cursor);
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/files?${parameters.toString()}`,
      FileChangePageSchema,
    );
  }

  searchEvents(
    sessionId: string,
    query: string,
    limit = 100,
  ): Promise<EventSearchResult> {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    return this.getJson(
      `/v1/sessions/${encodeURIComponent(sessionId)}/search?${parameters.toString()}`,
      EventSearchResultSchema,
    );
  }

  async getPayload(payloadId: string): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/payloads/${encodeURIComponent(payloadId)}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async streamEvents(
    sessionId: string,
    afterSequence: number,
    handlers: LiveEventHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    const parameters = new URLSearchParams({
      after: String(afterSequence),
    });
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/live?${parameters.toString()}`,
      { signal, headers: { accept: "text/event-stream" } },
    );
    if (response.body === null) {
      throw new ViewerApiError(0, "Live response body is unavailable.");
    }
    for await (const frame of parseServerEvents(response.body)) {
      if (frame.event === "tekrion.ready" || frame.event === "blackbox.ready") {
        const value = LiveEventReadySchema.parse(JSON.parse(frame.data));
        handlers.onReady?.(value.afterSequence);
      } else if (
        frame.event === "tekrion.event" ||
        frame.event === "blackbox.event"
      ) {
        handlers.onEvent(TekrionEventSchema.parse(JSON.parse(frame.data)));
      }
    }
  }

  private async getJson<T>(path: string, schema: Schema<T>): Promise<T> {
    const response = await this.request(path, {
      headers: { accept: "application/json" },
    });
    return schema.parse(await response.json());
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    schema: Schema<T>,
  ): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return schema.parse(await response.json());
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.token}`);
      response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        cache: "no-store",
        credentials: "omit",
        headers,
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new ViewerApiError(
        0,
        error instanceof Error ? error.message : "API connection failed.",
      );
    }
    if (!response.ok) {
      let code = response.statusText || "request_failed";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") {
          code = body.error;
        }
      } catch {
        // The status and inert fallback text are sufficient for non-JSON errors.
      }
      throw new ViewerApiError(response.status, code);
    }
    return response;
  }
}
