import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { SessionUpstreamRoute } from "@tekrion/protocol";

import { CliUsageError } from "./configuration.js";

export const ANTHROPIC_UPSTREAM_ORIGIN = "https://api.anthropic.com";
export const OPENAI_UPSTREAM_ORIGIN = "https://api.openai.com";

export type AgentIntegration = "codex" | "claude" | "openai-compatible";

const SUPPORTED_AGENT_VALUES = new Set([
  "auto",
  "codex",
  "claude",
  "openai-compatible",
]);

const CODEX_PACKAGE_RUNNERS = new Set([
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
]);

function executableName(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

export function resolveAgentIntegration(
  requested: string | undefined,
  executable: string,
): AgentIntegration {
  const selected = requested ?? "auto";
  if (!SUPPORTED_AGENT_VALUES.has(selected)) {
    throw new CliUsageError(
      "--agent must be auto, codex, claude, or openai-compatible.",
    );
  }
  if (selected !== "auto") {
    return selected as AgentIntegration;
  }
  const name = executableName(executable);
  if (name === "codex") {
    return "codex";
  }
  if (name === "claude") {
    return "claude";
  }
  return "openai-compatible";
}

export function defaultUpstreamForAgent(
  agent: AgentIntegration,
): string | undefined {
  if (agent === "claude") {
    return ANTHROPIC_UPSTREAM_ORIGIN;
  }
  return agent === "codex" ? OPENAI_UPSTREAM_ORIGIN : undefined;
}

export function sessionUpstreamRouteForAgent(
  agent: AgentIntegration,
  hasExplicitUpstream: boolean,
): SessionUpstreamRoute {
  return agent === "codex" && !hasExplicitUpstream ? "codex-auth" : "direct";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexRecorderProvider(sessionProxyOrigin: string): string {
  const suffix = createHash("sha256")
    .update(sessionProxyOrigin)
    .digest("hex")
    .slice(0, 16);
  return `tekrion_recorder_${suffix}`;
}

function codexConfigurationInsertionIndex(
  executable: string,
  arguments_: readonly string[],
): number | undefined {
  if (executableName(executable) === "codex") {
    return 0;
  }
  if (!CODEX_PACKAGE_RUNNERS.has(executableName(executable))) {
    return undefined;
  }
  const codexToken = arguments_.findIndex((argument) => {
    const normalized = argument.toLowerCase().replaceAll("\\", "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    return (
      /^codex(?:@[^/]+)?$/u.test(name) ||
      /^@openai\/codex(?:@[^/]+)?$/u.test(normalized)
    );
  });
  return codexToken === -1 ? undefined : codexToken + 1;
}

export interface PreparedAgentLaunch {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export function prepareAgentLaunch(
  agent: AgentIntegration,
  arguments_: readonly string[],
  sessionProxyOrigin: string,
  executable: string = agent,
): PreparedAgentLaunch {
  const openAiBaseUrl = `${sessionProxyOrigin}/v1`;
  const common = {
    TEKRION_AGENT: agent,
    BLACKBOX_AGENT: agent,
  };
  if (agent === "claude") {
    return {
      arguments: [...arguments_],
      environment: {
        ...common,
        ANTHROPIC_BASE_URL: sessionProxyOrigin,
      },
    };
  }
  if (agent === "codex") {
    const provider = codexRecorderProvider(sessionProxyOrigin);
    const providerPrefix = `model_providers.${provider}`;
    const overrides = [
      `model_provider=${tomlString(provider)}`,
      `${providerPrefix}.name=${tomlString("Tekrion Recorder")}`,
      `${providerPrefix}.base_url=${tomlString(openAiBaseUrl)}`,
      `${providerPrefix}.wire_api=${tomlString("responses")}`,
      `${providerPrefix}.requires_openai_auth=true`,
      `${providerPrefix}.supports_websockets=false`,
    ];
    const configurationArguments = overrides.flatMap((override) => [
      "--config",
      override,
    ]);
    const insertionIndex = codexConfigurationInsertionIndex(
      executable,
      arguments_,
    );
    return {
      arguments:
        insertionIndex === undefined
          ? [...arguments_]
          : [
              ...arguments_.slice(0, insertionIndex),
              ...configurationArguments,
              ...arguments_.slice(insertionIndex),
            ],
      environment: {
        ...common,
        OPENAI_BASE_URL: openAiBaseUrl,
      },
    };
  }
  return {
    arguments: [...arguments_],
    environment: {
      ...common,
      OPENAI_BASE_URL: openAiBaseUrl,
    },
  };
}
