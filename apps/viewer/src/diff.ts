import {
  FileDeltaPayloadSchema,
  type FileDeltaPayload,
} from "@tekrion/protocol";

export interface DecodedFileState {
  readonly kind: "text" | "binary" | "absent";
  readonly text?: string;
  readonly byteLength: number;
  readonly sha256?: string;
}

export interface DecodedFileDelta {
  readonly payload: FileDeltaPayload;
  readonly before: DecodedFileState;
  readonly after: DecodedFileState;
}

function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeState(value: FileDeltaPayload["before"]): DecodedFileState {
  if (value === null) {
    return { kind: "absent", byteLength: 0 };
  }
  const bytes = base64Bytes(value.content);
  if (bytes.byteLength !== value.byteLength) {
    return {
      kind: "binary",
      byteLength: bytes.byteLength,
      sha256: value.sha256,
    };
  }
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      byteLength: bytes.byteLength,
      sha256: value.sha256,
    };
  } catch {
    return {
      kind: "binary",
      byteLength: bytes.byteLength,
      sha256: value.sha256,
    };
  }
}

export function decodeFileDelta(bytes: Uint8Array): DecodedFileDelta {
  const payload = FileDeltaPayloadSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  return {
    payload,
    before: decodeState(payload.before),
    after: decodeState(payload.after),
  };
}

export function numberedLines(text: string | undefined): readonly string[] {
  if (text === undefined || text.length === 0) {
    return [];
  }
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}
