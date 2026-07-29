import type { TekrionEvent } from "@tekrion/protocol";

type JsonRecord = Record<string, unknown>;

const TOKEN_PATTERN = /[\p{L}\p{N}_./\\:-]+/gu;
const SHA256_PATTERN = /^[a-f\d]{64}$/u;

const EXCERPT_KEYS = [
  "content",
  "text",
  "output",
  "message",
  "reason",
  "command",
] as const;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
}

export function stringsIn(value: unknown): string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  return strings;
}

export function eventText(event: TekrionEvent): string {
  return [event.type, ...stringsIn(event.summary)].join("\n");
}

function firstStringForKey(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringForKey(item, key);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = value[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }
  for (const item of Object.values(value)) {
    const found = firstStringForKey(item, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function eventExcerpt(
  event: TekrionEvent,
  maximumCharacters = 480,
): string | undefined {
  for (const key of EXCERPT_KEYS) {
    const value = firstStringForKey(event.summary, key)?.trim();
    if (value !== undefined && value.length > 0) {
      return value.slice(0, maximumCharacters);
    }
  }
  const fallback = stringsIn(event.summary).find(
    (value) => value.trim().length > 0,
  );
  return fallback?.trim().slice(0, maximumCharacters);
}

export function tokenize(value: string): string[] {
  return (value.toLocaleLowerCase().match(TOKEN_PATTERN) ?? [])
    .flatMap((token) => [token, ...token.split(/[./\\:_-]+/u)])
    .map((token) => token.replace(/^[-.]+|[-.]+$/gu, ""))
    .filter((token) => token.length > 1);
}

export function lexicalCoverage(
  documentTokens: readonly string[],
  queryTokens: readonly string[],
): number {
  const query = new Set(queryTokens);
  if (query.size === 0) {
    return 0;
  }
  const document = new Set(documentTokens);
  let matches = 0;
  for (const token of query) {
    if (document.has(token)) {
      matches += 1;
    }
  }
  return matches / query.size;
}

export function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function pathFromRecord(record: JsonRecord): string | undefined {
  for (const key of [
    "path",
    "filePath",
    "filename",
    "file",
    "target",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  for (const key of ["arguments", "args", "input"] as const) {
    const value = record[key];
    if (isRecord(value)) {
      const found = pathFromRecord(value);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

export function eventPath(event: TekrionEvent): string | undefined {
  return pathFromRecord(event.summary);
}

export function eventArguments(event: TekrionEvent): JsonRecord {
  const direct = event.summary.arguments ?? event.summary.args;
  if (isRecord(direct)) {
    return direct;
  }
  const path = eventPath(event);
  return {
    ...(path === undefined ? {} : { path }),
    ...(typeof event.summary.name === "string"
      ? { name: event.summary.name }
      : {}),
  };
}

export function stringsContainPath(value: string, path: string): boolean {
  const normalizedValue = normalizedPath(value);
  const normalizedTarget = normalizedPath(path);
  if (normalizedValue.includes(normalizedTarget)) {
    return true;
  }
  const basename = normalizedTarget.split("/").at(-1);
  return basename !== undefined && basename.length > 2
    ? normalizedValue.includes(basename)
    : false;
}

function collectHashes(value: unknown, output: Set<string>): void {
  if (typeof value === "string" && SHA256_PATTERN.test(value)) {
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHashes(item, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectHashes(item, output);
    }
  }
}

export function eventHashes(event: TekrionEvent): Set<string> {
  const hashes = new Set<string>();
  collectHashes(event.summary, hashes);
  if (event.payloadRef !== undefined) {
    hashes.add(event.payloadRef.sha256);
  }
  return hashes;
}

export function sharedValue<T>(left: Set<T>, right: Set<T>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}
