import type { CaptureLevel, TekrionEvent } from "@tekrion/protocol";

export type TimelineLane = "model" | "tools" | "system" | "risk" | "context";
export type TimestampMode = "relative" | "local" | "utc";

export const TIMELINE_LANES: readonly TimelineLane[] = [
  "model",
  "tools",
  "system",
  "risk",
  "context",
];

export const TIMELINE_LANE_LABELS: Readonly<Record<TimelineLane, string>> = {
  model: "Conversation",
  tools: "Tools",
  system: "Files & process",
  risk: "Needs attention",
  context: "Usage & context",
};

const PRESERVED_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  http: "HTTP",
  id: "ID",
  json: "JSON",
  sse: "SSE",
  url: "URL",
  utc: "UTC",
};

const CAPTURE_LEVEL_LABELS: Readonly<Record<CaptureLevel, string>> = {
  api: "API traffic",
  "wrapped-process": "Process & workspace",
  adapter: "Agent integration",
};

const FRIENDLY_IDENTIFIER_FIELDS = new Set([
  "evidence",
  "name",
  "operation",
  "role",
  "source",
  "status",
  "timingPrecision",
]);

const PREVIEW_TEXT_FIELDS = [
  "text",
  "message",
  "command",
  "content",
  "output",
  "error",
  "reason",
] as const;

const PREVIEW_OMITTED_FIELDS = new Set([
  "name",
  "path",
  "role",
  ...PREVIEW_TEXT_FIELDS,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function humanizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .split(/[._\s-]+/u)
    .filter(Boolean)
    .map((word, index) => {
      const preserved = PRESERVED_WORDS[word.toLowerCase()];
      if (preserved !== undefined) {
        return preserved;
      }
      return index === 0
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : word.toLowerCase();
    })
    .join(" ");
}

export function captureLevelLabel(value: CaptureLevel): string {
  return CAPTURE_LEVEL_LABELS[value];
}

export function eventFieldValue(name: string, value: unknown): string {
  if (name === "captureLevel" && typeof value === "string") {
    return (
      CAPTURE_LEVEL_LABELS[value as CaptureLevel] ?? humanizeIdentifier(value)
    );
  }
  if (typeof value === "string" && FRIENDLY_IDENTIFIER_FIELDS.has(name)) {
    return humanizeIdentifier(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null || typeof value === "number") {
    return String(value);
  }
  if (value === undefined) {
    return "Not recorded";
  }
  if (Array.isArray(value)) {
    if (
      value.every(
        (item) =>
          item === null ||
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    ) {
      return value.map((item) => eventFieldValue(name, item)).join(", ");
    }
    return `${value.length.toLocaleString()} items`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const readable = entries
      .slice(0, 4)
      .map(
        ([childName, childValue]) =>
          `${humanizeIdentifier(childName)}: ${eventFieldValue(childName, childValue)}`,
      )
      .join(" · ");
    return `${readable}${entries.length > 4 ? " · …" : ""}`;
  }
  return JSON.stringify(value);
}

export function eventCategoryLabel(event: TekrionEvent): string {
  return TIMELINE_LANE_LABELS[classifyEvent(event)];
}

export function eventTypeLabel(event: TekrionEvent): string {
  const [scope, action] = event.type.split(".");
  if (scope === "message" && action !== undefined) {
    return `${humanizeIdentifier(action)} message`;
  }
  if (scope === "file" && action !== undefined) {
    return `${humanizeIdentifier(action)} file`;
  }
  if (scope === "process" && action !== undefined) {
    return `Process ${action.replaceAll("-", " ")}`;
  }
  if (scope === "tool" && action === "call") {
    return "Tool requested";
  }
  if (scope === "tool" && action === "result") {
    return "Tool completed";
  }
  return humanizeIdentifier(event.type);
}

export function classifyEvent(event: TekrionEvent): TimelineLane {
  const type = event.type.toLowerCase();
  if (
    type.includes("error") ||
    type.includes("crash") ||
    type.includes("disconnect") ||
    type.includes("timeout") ||
    (type.startsWith("file.") &&
      new Set(["delete", "rename"]).has(type.slice("file.".length)))
  ) {
    return "risk";
  }
  if (type.includes("tool") || type.includes("function")) {
    return "tools";
  }
  if (
    event.source === "filesystem" ||
    event.source === "process" ||
    type.startsWith("file.") ||
    type.startsWith("process.") ||
    type.startsWith("workspace.")
  ) {
    return "system";
  }
  if (
    type.includes("usage") ||
    type.includes("token") ||
    type.includes("context")
  ) {
    return "context";
  }
  return "model";
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

export function eventTitle(event: TekrionEvent): string {
  const summary = event.summary;
  const path = firstText(summary.path);
  if (path !== undefined) {
    return path;
  }
  const name = firstText(summary.name);
  if (name !== undefined) {
    return humanizeIdentifier(name);
  }
  const role = firstText(summary.role);
  if (role !== undefined && event.type.startsWith("message.")) {
    return `${humanizeIdentifier(role)} message`;
  }
  return role ?? eventTypeLabel(event);
}

export function eventPreview(event: TekrionEvent, maximum = 180): string {
  const summary = event.summary;

  for (const field of PREVIEW_TEXT_FIELDS) {
    const text = firstText(summary[field]);
    if (text !== undefined) {
      return text.length <= maximum
        ? text
        : `${text.slice(0, Math.max(0, maximum - 1))}…`;
    }
  }

  if (event.type === "file.delete") {
    return "File deleted from the workspace.";
  }
  if (event.type === "tool.result" && summary.success === true) {
    return "Completed successfully.";
  }

  const readableFields = Object.entries(summary)
    .filter(
      ([name]) =>
        !PREVIEW_OMITTED_FIELDS.has(name) &&
        !name.toLowerCase().includes("hash"),
    )
    .slice(0, 3)
    .map(([name, value]) => {
      if (name === "arguments" || name === "parameters") {
        return eventFieldValue(name, value);
      }
      return `${humanizeIdentifier(name)}: ${eventFieldValue(name, value)}`;
    })
    .join(" · ");
  const candidate = readableFields || eventTypeLabel(event);
  return candidate.length <= maximum
    ? candidate
    : `${candidate.slice(0, Math.max(0, maximum - 1))}…`;
}

export function mergeTimelineEvents(
  existing: readonly TekrionEvent[],
  incoming: readonly TekrionEvent[],
): TekrionEvent[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

export function formatEventTime(
  event: TekrionEvent,
  sessionStartedAt: string,
  mode: TimestampMode,
): string {
  const time = new Date(event.occurredAt);
  if (mode === "utc") {
    return time.toISOString().replace("T", " ").replace("Z", " UTC");
  }
  if (mode === "local") {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(time);
  }
  const elapsed = Math.max(0, time.getTime() - Date.parse(sessionStartedAt));
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = ((elapsed % 60_000) / 1000).toFixed(3).padStart(6, "0");
  return `+${String(minutes).padStart(2, "0")}:${seconds}`;
}
