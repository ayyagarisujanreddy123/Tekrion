import type { TekrionEvent } from "@tekrion/protocol";

export type TimelineLane = "model" | "tools" | "system" | "risk" | "context";
export type TimestampMode = "relative" | "local" | "utc";

export const TIMELINE_LANES: readonly TimelineLane[] = [
  "model",
  "tools",
  "system",
  "risk",
  "context",
];

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
  return (
    firstText(summary.path) ??
    firstText(summary.name) ??
    firstText(summary.role) ??
    event.type
  );
}

export function eventPreview(event: TekrionEvent, maximum = 180): string {
  const summary = event.summary;
  const candidate =
    firstText(summary.text) ??
    firstText(summary.message) ??
    firstText(summary.command) ??
    firstText(summary.path) ??
    JSON.stringify(summary);
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
