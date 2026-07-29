import {
  AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
  REPORT_AI_INSTRUCTIONS,
  REPORT_PROMPT_VERSION,
  type AiReportProviderRequest,
} from "@tekrion/analysis";
import { describe, expect, it, vi } from "vitest";

import {
  OpenAiReportProvider,
  openAiReportProviderFromEnvironment,
} from "../src/index.js";

const API_KEY = "analysis-fixture-secret";

function request(): AiReportProviderRequest {
  return {
    analysisSessionId: "session-analysis",
    targetSessionId: "session-target",
    promptVersion: REPORT_PROMPT_VERSION,
    instructions: REPORT_AI_INSTRUCTIONS,
    evidenceSnapshot: '{"schemaVersion":1,"categories":[]}',
    jsonSchema: AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
  };
}

function validNarrative(): Record<string, unknown> {
  const citation = { eventId: "event-target", excerpt: "target.txt" };
  return {
    schemaVersion: 1,
    impact: { statement: "A file changed.", citations: [citation] },
    rootCauseHypothesis: {
      statement: "A preceding action may have caused the change.",
      confidence: "low",
      citations: [citation],
    },
    contributingConditions: [],
    counterevidence: [],
    alternatives: [],
    preventionActions: [],
    limitations: [],
  };
}

describe("OpenAI-compatible incident report provider", () => {
  it("uses strict Responses structured output without provider storage", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      expect(String(input)).toBe("https://analysis.example/v1/responses");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${API_KEY}`,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "fixture-model",
        store: false,
        instructions: REPORT_AI_INSTRUCTIONS,
        text: {
          format: {
            type: "json_schema",
            name: "tekrion_incident_report",
            strict: true,
            schema: AI_INCIDENT_NARRATIVE_JSON_SCHEMA,
          },
        },
      });
      expect(body.input).toBe(
        'BEGIN_UNTRUSTED_EVIDENCE_SNAPSHOT_JSON\n{"schemaVersion":1,"categories":[]}\nEND_UNTRUSTED_EVIDENCE_SNAPSHOT_JSON',
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(validNarrative()),
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 45,
              total_tokens: 165,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const provider = new OpenAiReportProvider({
      apiKey: API_KEY,
      model: "fixture-model",
      baseUrl: "https://analysis.example/v1/",
      fetcher,
    });

    await expect(provider.analyze(request())).resolves.toEqual({
      output: validNarrative(),
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("treats refusal and malformed structured output as failures", async () => {
    const refusal = new OpenAiReportProvider({
      apiKey: API_KEY,
      model: "fixture-model",
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              output: [
                {
                  type: "message",
                  content: [{ type: "refusal", refusal: "not available" }],
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });
    const malformed = new OpenAiReportProvider({
      apiKey: API_KEY,
      model: "fixture-model",
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "not json" }],
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });

    await expect(refusal.analyze(request())).rejects.toThrow("refused");
    await expect(malformed.analyze(request())).rejects.toThrow(
      "not valid structured JSON",
    );
  });

  it("requires dedicated Tekrion analysis configuration", () => {
    expect(
      openAiReportProviderFromEnvironment({
        OPENAI_API_KEY: API_KEY,
        OPENAI_MODEL: "fixture-model",
      }),
    ).toBeUndefined();
    expect(
      openAiReportProviderFromEnvironment({
        TEKRION_ANALYSIS_API_KEY: API_KEY,
        TEKRION_ANALYSIS_MODEL: "fixture-model",
        TEKRION_ANALYSIS_PROVIDER: "fixture-provider",
      }),
    ).toMatchObject({
      provider: "fixture-provider",
      model: "fixture-model",
    });
    expect(
      openAiReportProviderFromEnvironment({
        BLACKBOX_ANALYSIS_API_KEY: API_KEY,
        BLACKBOX_ANALYSIS_MODEL: "legacy-model",
        BLACKBOX_ANALYSIS_PROVIDER: "legacy-provider",
      }),
    ).toMatchObject({
      provider: "legacy-provider",
      model: "legacy-model",
    });
  });

  it("rejects unsafe base URLs and bounds provider responses", async () => {
    expect(
      () =>
        new OpenAiReportProvider({
          apiKey: API_KEY,
          model: "fixture-model",
          baseUrl: "https://user:password@analysis.example/v1/",
        }),
    ).toThrow("without credentials");
    const provider = new OpenAiReportProvider({
      apiKey: API_KEY,
      model: "fixture-model",
      maximumResponseBytes: 8,
      fetcher: () =>
        Promise.resolve(
          new Response("123456789", {
            status: 200,
            headers: { "content-length": "9" },
          }),
        ),
    });

    await expect(provider.analyze(request())).rejects.toThrow("size limit");

    let canceled = false;
    const streamedChunk = new TextEncoder().encode("12345");
    const streamed = new OpenAiReportProvider({
      apiKey: API_KEY,
      model: "fixture-model",
      maximumResponseBytes: 8,
      fetcher: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(streamedChunk);
              },
              cancel() {
                canceled = true;
              },
            }),
            { status: 200 },
          ),
        ),
    });

    await expect(streamed.analyze(request())).rejects.toThrow("size limit");
    expect(canceled).toBe(true);
  });
});
