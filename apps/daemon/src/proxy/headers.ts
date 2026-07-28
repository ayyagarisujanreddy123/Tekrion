import { SafeHeadersSchema, type SafeHeaders } from "@blackbox/protocol";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const STANDARD_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const NEVER_PERSIST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const values = headers.connection;
  const joined = Array.isArray(values) ? values.join(",") : (values ?? "");
  return new Set(
    joined
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

function values(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function headersForForwarding(
  headers: IncomingHttpHeaders,
  options: {
    readonly dropHost?: boolean;
    readonly dropNames?: readonly string[];
  } = {},
): OutgoingHttpHeaders {
  const connectionSpecific = connectionTokens(headers);
  const explicitlyDropped = new Set(
    (options.dropNames ?? []).map((name) => name.toLowerCase()),
  );
  const result = new Map<string, string | string[]>();

  for (const [originalName, originalValue] of Object.entries(headers)) {
    const name = originalName.toLowerCase();
    if (
      STANDARD_HOP_BY_HOP_HEADERS.has(name) ||
      connectionSpecific.has(name) ||
      explicitlyDropped.has(name) ||
      (options.dropHost === true && name === "host") ||
      originalValue === undefined
    ) {
      continue;
    }
    result.set(name, originalValue);
  }
  return Object.fromEntries(result);
}

export function headersForPersistence(
  headers: IncomingHttpHeaders,
  additionalSensitiveNames: readonly string[] = [],
): SafeHeaders {
  const sensitive = new Set([
    ...NEVER_PERSIST_HEADERS,
    ...additionalSensitiveNames.map((name) => name.toLowerCase()),
  ]);
  const connectionSpecific = connectionTokens(headers);
  const persisted = new Map<string, string[]>();

  for (const [originalName, originalValue] of Object.entries(headers)) {
    const name = originalName.toLowerCase();
    if (
      sensitive.has(name) ||
      STANDARD_HOP_BY_HOP_HEADERS.has(name) ||
      connectionSpecific.has(name)
    ) {
      continue;
    }
    const normalizedValues = values(originalValue);
    if (normalizedValues.length > 0) {
      persisted.set(name, normalizedValues);
    }
  }

  return SafeHeadersSchema.parse(Object.fromEntries(persisted));
}
