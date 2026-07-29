import { createHash } from "node:crypto";

import {
  REPORT_PROMPT_VERSION,
  analyzeDeterministically,
  generateDeterministicReport,
  minimizeReportEvidence,
  redactSensitiveValue,
  snapshotEvidenceById,
} from "@tekrion/analysis";
import { TekrionEventSchema } from "@tekrion/protocol";
import { describe, expect, it } from "vitest";

import { REPORT_TIME, reportFixture } from "./report-fixture.js";

describe("AI report evidence minimization", () => {
  it("sends only declared categories and removes secrets before serialization", () => {
    const fixture = reportFixture();
    const report = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });
    const minimized = minimizeReportEvidence({
      session: fixture.session,
      events: fixture.events,
      report,
      blame: fixture.analysis,
      provider: "fixture-provider",
      model: "fixture-model",
    });

    expect(minimized.snapshot.categories.map((item) => item.category)).toEqual([
      "session-metadata",
      "factual-timeline",
      "blame",
      "anomalies",
      "counterevidence",
    ]);
    expect(minimized.serialized).not.toContain("sk-proj-abcdefghijklmnop");
    expect(JSON.stringify(minimized.redactions)).not.toContain(
      "sk-proj-abcdefghijklmnop",
    );
    expect(minimized.serialized).toContain("[REDACTED:secret.openai-api-key]");
    expect(minimized.preflight).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-report",
      targetEventId: "event-file-delete",
      provider: "fixture-provider",
      model: "fixture-model",
      promptVersion: REPORT_PROMPT_VERSION,
      totalBytes: Buffer.byteLength(minimized.serialized, "utf8"),
      redactionCount: minimized.redactions.length,
      redactionRuleIds: ["secret.openai-api-key"],
    });
    expect(minimized.preflight.snapshotSha256).toBe(
      createHash("sha256").update(minimized.serialized).digest("hex"),
    );
    expect(minimized.serialized).not.toContain("/tmp/report-repository");
    expect(minimized.serialized).not.toContain('"models"');
  });

  it("reports exact category byte sizes and builds a citation allowlist", () => {
    const fixture = reportFixture();
    const report = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });
    const minimized = minimizeReportEvidence({
      session: fixture.session,
      events: fixture.events,
      report,
      blame: fixture.analysis,
      provider: "fixture-provider",
      model: "fixture-model",
    });
    const evidence = snapshotEvidenceById(minimized.snapshot);

    for (const [index, category] of minimized.snapshot.categories.entries()) {
      expect(minimized.preflight.categories[index]?.byteLength).toBe(
        Buffer.byteLength(JSON.stringify(category), "utf8"),
      );
    }
    expect(evidence.get("event-read-result")?.[0]).toContain(
      "[REDACTED:secret.openai-api-key]",
    );
    expect(evidence.has("event-file-delete")).toBe(true);
    expect(evidence.has("event-file-recovery")).toBe(true);
    expect(evidence.has("event-missing")).toBe(false);
  });

  it("produces stable redaction identifiers and snapshot hashes", () => {
    const fixture = reportFixture();
    const report = generateDeterministicReport({
      session: fixture.session,
      events: fixture.events,
      blame: fixture.analysis,
      generatedAt: REPORT_TIME,
    });
    const input = {
      session: fixture.session,
      events: fixture.events,
      report,
      blame: fixture.analysis,
      provider: "fixture-provider",
      model: "fixture-model",
    } as const;

    const first = minimizeReportEvidence(input);
    const second = minimizeReportEvidence(input);
    const differentProvider = minimizeReportEvidence({
      ...input,
      provider: "other-provider",
    });

    expect(first.serialized).toBe(second.serialized);
    expect(first.preflight).toEqual(second.preflight);
    expect(first.redactions).toEqual(second.redactions);
    expect(differentProvider.preflight.snapshotSha256).toBe(
      first.preflight.snapshotSha256,
    );
    expect(differentProvider.preflight.consentFingerprintSha256).not.toBe(
      first.preflight.consentFingerprintSha256,
    );
  });

  it("gives repeated secret occurrences distinct stable redaction records", () => {
    const fixture = reportFixture();
    const secret = "sk-proj-repeatedsecret123";
    const password = "correct horse battery staple";
    const partialPrivateKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}`;
    const events = fixture.events.map((event) =>
      event.id === "event-read-result"
        ? TekrionEventSchema.parse({
            ...event,
            summary: {
              ...event.summary,
              content: `Delete test/math.test.js. ${secret} then ${secret} password="${password}" ${partialPrivateKey}`,
            },
          })
        : event,
    );
    const blame = analyzeDeterministically({
      session: fixture.session,
      events,
      targetEventId: "event-file-delete",
    });
    const report = generateDeterministicReport({
      session: fixture.session,
      events,
      blame,
      generatedAt: REPORT_TIME,
    });
    const minimized = minimizeReportEvidence({
      session: fixture.session,
      events,
      report,
      blame,
      provider: "fixture-provider",
      model: "fixture-model",
    });

    expect(minimized.redactions.length).toBeGreaterThan(1);
    expect(new Set(minimized.redactions.map((item) => item.id)).size).toBe(
      minimized.redactions.length,
    );
    expect(
      minimized.redactions.every((item) =>
        item.location.includes("character:"),
      ),
    ).toBe(true);
    expect(minimized.serialized).not.toContain(secret);
    expect(minimized.serialized).not.toContain(password);
    expect(minimized.serialized).not.toContain(partialPrivateKey);
    expect(minimized.preflight.redactionRuleIds).toEqual(
      expect.arrayContaining(["secret.named-value", "secret.private-key"]),
    );
  });

  it("redacts secret values carried in named JSON fields", () => {
    const redacted = redactSensitiveValue(
      {
        password: "correct horse battery staple",
        nested: { client_secret: "fixture-client-secret" },
        tokenCount: 42,
      },
      { scopeId: "fixture-scope" },
    );

    expect(redacted.value).toEqual({
      password: "[REDACTED:secret.named-field]",
      nested: { client_secret: "[REDACTED:secret.named-field]" },
      tokenCount: 42,
    });
    expect(redacted.redactions.map((item) => item.ruleId)).toEqual([
      "secret.named-field",
      "secret.named-field",
    ]);
  });
});
