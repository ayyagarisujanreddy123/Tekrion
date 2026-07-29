import {
  AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
  type AiReportProvider,
  type AiReportProviderRequest,
  type AiReportProviderResponse,
} from "@tekrion/analysis";
import {
  ReportAnalysisUsageSchema,
  type ReportAnalysisUsage,
} from "@tekrion/protocol";
import { z } from "zod";

const TimeoutSchema = z
  .number()
  .int()
  .positive()
  .max(5 * 60_000);
const MaximumResponseBytesSchema = z
  .number()
  .int()
  .positive()
  .max(64 * 1024 * 1024);

export interface OpenAiReportProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
  readonly fetcher?: typeof fetch;
}

interface ProviderContent {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly refusal?: unknown;
}

interface ProviderOutput {
  readonly type?: unknown;
  readonly content?: unknown;
}

interface ProviderResponse {
  readonly output?: unknown;
  readonly output_text?: unknown;
  readonly usage?: unknown;
}

type PrivacyRequestInit = RequestInit & {
  readonly cache: "no-store";
  readonly credentials: "omit";
  readonly referrerPolicy: "no-referrer";
};

function requiredSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 16_384) {
    throw new RangeError("The analysis API key is missing or invalid.");
  }
  return trimmed;
}

function requiredName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 512) {
    throw new RangeError(`${label} must contain 1 to 512 characters.`);
  }
  return trimmed;
}

function responsesUrl(value: string): URL {
  const base = new URL(value);
  if (
    !new Set(["http:", "https:"]).has(base.protocol) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new RangeError(
      "The analysis base URL must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  const path = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  base.pathname = `${path}responses`.replace(/\/{2,}/gu, "/");
  return base;
}

function usage(value: unknown): ReportAnalysisUsage {
  if (typeof value !== "object" || value === null) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    };
  }
  const record = value as Record<string, unknown>;
  const token = (name: string): number | null => {
    const candidate = record[name];
    return typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : null;
  };
  return ReportAnalysisUsageSchema.parse({
    inputTokens: token("input_tokens"),
    outputTokens: token("output_tokens"),
    totalTokens: token("total_tokens"),
  });
}

function outputText(value: ProviderResponse): string {
  if (typeof value.output_text === "string" && value.output_text.length > 0) {
    return value.output_text;
  }
  if (!Array.isArray(value.output)) {
    throw new Error("The analysis provider response contains no output items.");
  }
  const texts: string[] = [];
  for (const rawOutput of value.output) {
    const output = rawOutput as ProviderOutput;
    if (output.type !== "message" || !Array.isArray(output.content)) {
      continue;
    }
    for (const rawContent of output.content) {
      const content = rawContent as ProviderContent;
      if (content.type === "refusal" && typeof content.refusal === "string") {
        throw new Error("The analysis provider refused the request.");
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  if (texts.length === 0) {
    throw new Error("The analysis provider response contains no output text.");
  }
  return texts.join("");
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
): Promise<ProviderResponse> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isSafeInteger(Number(contentLength)) &&
    Number(contentLength) > maximumBytes
  ) {
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new Error("The analysis provider response exceeded the size limit.");
  }
  if (response.body === null) {
    throw new Error("The analysis provider returned an empty response body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          "The analysis provider response exceeded the size limit.",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ProviderResponse;
  } catch (error: unknown) {
    throw new Error("The analysis provider returned malformed JSON.", {
      cause: error,
    });
  }
}

export class OpenAiReportProvider implements AiReportProvider {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: URL;
  readonly timeoutMilliseconds: number;
  readonly maximumResponseBytes: number;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiReportProviderOptions) {
    this.apiKey = requiredSecret(options.apiKey);
    this.model = requiredName(options.model, "Analysis model");
    this.provider = requiredName(
      options.provider ?? "openai-compatible",
      "Analysis provider",
    );
    this.endpoint = responsesUrl(
      options.baseUrl ?? "https://api.openai.com/v1/",
    );
    this.timeoutMilliseconds = TimeoutSchema.parse(
      options.timeoutMilliseconds ?? 60_000,
    );
    this.maximumResponseBytes = MaximumResponseBytesSchema.parse(
      options.maximumResponseBytes ?? 2 * 1024 * 1024,
    );
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async analyze(
    request: AiReportProviderRequest,
  ): Promise<AiReportProviderResponse> {
    if (request.jsonSchema !== AI_INCIDENT_NARRATIVE_JSON_SCHEMA) {
      throw new Error("The AI report provider received an unknown schema.");
    }
    const requestInit: PrivacyRequestInit = {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: request.instructions,
        input: `BEGIN_UNTRUSTED_EVIDENCE_SNAPSHOT_JSON\n${request.evidenceSnapshot}\nEND_UNTRUSTED_EVIDENCE_SNAPSHOT_JSON`,
        text: {
          format: {
            type: "json_schema",
            name: "tekrion_incident_report",
            strict: true,
            schema: request.jsonSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    };
    const response = await this.fetcher(this.endpoint, requestInit);
    const parsed = await boundedJson(response, this.maximumResponseBytes);
    if (!response.ok) {
      throw new Error(
        `The analysis provider returned HTTP ${response.status}.`,
      );
    }
    let output: unknown;
    try {
      output = JSON.parse(outputText(parsed));
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new Error(
          "The analysis provider output was not valid structured JSON.",
          { cause: error },
        );
      }
      throw error;
    }
    return { output, usage: usage(parsed.usage) };
  }
}

export function openAiReportProviderFromEnvironment(
  environment: NodeJS.ProcessEnv,
  fetcher?: typeof fetch,
): OpenAiReportProvider | undefined {
  const apiKey =
    environment.TEKRION_ANALYSIS_API_KEY ??
    environment.BLACKBOX_ANALYSIS_API_KEY;
  const model =
    environment.TEKRION_ANALYSIS_MODEL ?? environment.BLACKBOX_ANALYSIS_MODEL;
  const baseUrl =
    environment.TEKRION_ANALYSIS_BASE_URL ??
    environment.BLACKBOX_ANALYSIS_BASE_URL;
  const provider =
    environment.TEKRION_ANALYSIS_PROVIDER ??
    environment.BLACKBOX_ANALYSIS_PROVIDER;
  if (apiKey === undefined || model === undefined) {
    return undefined;
  }
  return new OpenAiReportProvider({
    apiKey,
    model,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(provider === undefined ? {} : { provider }),
    ...(fetcher === undefined ? {} : { fetcher }),
  });
}
