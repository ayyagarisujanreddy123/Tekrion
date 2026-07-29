import type { ServerResponse } from "node:http";

import type { BlobReference } from "@tekrion/protocol";

const INERT_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
} as const;

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    ...INERT_RESPONSE_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    ...extraHeaders,
  });
  response.end(body);
}

export function sendInertPayload(
  response: ServerResponse,
  reference: BlobReference,
  bytes: Uint8Array,
): void {
  response.writeHead(200, {
    ...INERT_RESPONSE_HEADERS,
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="tekrion-payload.bin"',
    "content-length": bytes.byteLength,
    "x-tekrion-byte-length": String(reference.byteLength),
    "x-tekrion-sha256": reference.sha256,
    "x-tekrion-truncated": String(reference.truncated),
  });
  response.end(Buffer.from(bytes));
}

export function beginEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    ...INERT_RESPONSE_HEADERS,
    "cache-control": "no-cache, no-store, must-revalidate, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}
