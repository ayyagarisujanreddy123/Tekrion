import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_UPSTREAM_ORIGIN,
  CliUsageError,
  OPENAI_UPSTREAM_ORIGIN,
  defaultUpstreamForAgent,
  prepareAgentLaunch,
  resolveAgentIntegration,
  sessionUpstreamRouteForAgent,
} from "../src/index.js";

describe("agent integrations", () => {
  it("auto-detects Codex and Claude without misclassifying other clients", () => {
    expect(resolveAgentIntegration(undefined, "/usr/local/bin/codex")).toBe(
      "codex",
    );
    expect(resolveAgentIntegration("auto", "C:\\tools\\claude.exe")).toBe(
      process.platform === "win32" ? "claude" : "openai-compatible",
    );
    expect(resolveAgentIntegration("auto", "/usr/local/bin/claude")).toBe(
      "claude",
    );
    expect(resolveAgentIntegration("auto", "custom-agent")).toBe(
      "openai-compatible",
    );
  });

  it("validates explicit agent selections", () => {
    expect(resolveAgentIntegration("claude", "anything")).toBe("claude");
    expect(() => resolveAgentIntegration("future-agent", "anything")).toThrow(
      CliUsageError,
    );
  });

  it("launches Codex through an authenticated HTTP-only recorder provider", () => {
    const sessionProxyOrigin =
      "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg";
    const provider = `blackbox_recorder_${createHash("sha256")
      .update(sessionProxyOrigin)
      .digest("hex")
      .slice(0, 16)}`;
    const prepared = prepareAgentLaunch(
      "codex",
      ["exec", "inspect this project"],
      sessionProxyOrigin,
    );

    expect(prepared.arguments).toEqual([
      "--config",
      `model_provider="${provider}"`,
      "--config",
      `model_providers.${provider}.name="Black Box Recorder"`,
      "--config",
      `model_providers.${provider}.base_url="${sessionProxyOrigin}/v1"`,
      "--config",
      `model_providers.${provider}.wire_api="responses"`,
      "--config",
      `model_providers.${provider}.requires_openai_auth=true`,
      "--config",
      `model_providers.${provider}.supports_websockets=false`,
      "exec",
      "inspect this project",
    ]);
    expect(defaultUpstreamForAgent("codex")).toBe(OPENAI_UPSTREAM_ORIGIN);
    expect(prepared.environment).toEqual({
      BLACKBOX_AGENT: "codex",
      OPENAI_BASE_URL: "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg/v1",
    });
    expect(sessionUpstreamRouteForAgent("codex", false)).toBe("codex-auth");
    expect(sessionUpstreamRouteForAgent("codex", true)).toBe("direct");
  });

  it("places Codex configuration after a package-runner command", () => {
    const prepared = prepareAgentLaunch(
      "codex",
      ["--yes", "@openai/codex@latest", "exec", "inspect this project"],
      "http://127.0.0.1:4141/.blackbox/session/cGFja2FnZS1ydW5uZXI",
      "/usr/local/bin/npx",
    );

    expect(prepared.arguments.slice(0, 3)).toEqual([
      "--yes",
      "@openai/codex@latest",
      "--config",
    ]);
    expect(prepared.arguments.slice(-2)).toEqual([
      "exec",
      "inspect this project",
    ]);
  });

  it("launches Claude with its native base URL and provider default", () => {
    const prepared = prepareAgentLaunch(
      "claude",
      ["-p", "inspect this project"],
      "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg",
    );

    expect(defaultUpstreamForAgent("claude")).toBe(ANTHROPIC_UPSTREAM_ORIGIN);
    expect(prepared).toEqual({
      arguments: ["-p", "inspect this project"],
      environment: {
        BLACKBOX_AGENT: "claude",
        ANTHROPIC_BASE_URL:
          "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg",
      },
    });
    expect(prepared.environment).not.toHaveProperty("OPENAI_BASE_URL");
    expect(sessionUpstreamRouteForAgent("claude", false)).toBe("direct");
  });
});
