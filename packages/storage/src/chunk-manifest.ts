import { createHash } from "node:crypto";

import { IdentifierSchema, Sha256Schema } from "@tekrion/protocol";
import { z } from "zod";

import type { BlobStore } from "./blob-store.js";

const BigIntStringSchema = z.string().regex(/^\d+$/u);

export const ChunkManifestEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    direction: z.enum(["request", "response"]),
    monotonicOffsetNs: BigIntStringSchema,
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

export const ChunkManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    exchangeId: IdentifierSchema,
    startedMonotonicNs: BigIntStringSchema,
    completed: z.boolean(),
    truncated: z.boolean(),
    droppedEntryCount: z.number().int().nonnegative(),
    droppedByteCount: z.number().int().nonnegative(),
    entries: z.array(ChunkManifestEntrySchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.truncated !== manifest.droppedEntryCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Manifest truncation must agree with the dropped entry count",
        path: ["truncated"],
      });
    }
    if (!manifest.truncated && manifest.droppedByteCount !== 0) {
      context.addIssue({
        code: "custom",
        message: "A complete manifest cannot report dropped bytes",
        path: ["droppedByteCount"],
      });
    }

    const offsets = { request: 0, response: 0 };
    let previousMonotonic = -1n;

    manifest.entries.forEach((entry, index) => {
      if (entry.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Chunk sequence must be contiguous",
          path: ["entries", index, "sequence"],
        });
      }
      const monotonic = BigInt(entry.monotonicOffsetNs);
      if (monotonic < previousMonotonic) {
        context.addIssue({
          code: "custom",
          message: "Chunk monotonic offsets must not decrease",
          path: ["entries", index, "monotonicOffsetNs"],
        });
      }
      previousMonotonic = monotonic;
      if (entry.byteOffset !== offsets[entry.direction]) {
        context.addIssue({
          code: "custom",
          message: "Chunk byte offsets must be contiguous per direction",
          path: ["entries", index, "byteOffset"],
        });
      }
      offsets[entry.direction] += entry.byteLength;
    });
  });

export type ChunkManifest = z.infer<typeof ChunkManifestSchema>;
export type ChunkManifestEntry = z.infer<typeof ChunkManifestEntrySchema>;

export class ChunkManifestBuilder {
  private readonly entries: ChunkManifestEntry[] = [];
  private readonly offsets = { request: 0, response: 0 };
  private lastObservedNs: bigint;
  private droppedEntries = 0;
  private droppedBytes = 0;

  constructor(
    readonly exchangeId: string,
    readonly startedMonotonicNs: bigint = process.hrtime.bigint(),
    readonly maximumEntries: number = 100_000,
  ) {
    IdentifierSchema.parse(exchangeId);
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError(
        "Chunk manifest entry limit must be a positive integer.",
      );
    }
    this.lastObservedNs = startedMonotonicNs;
  }

  get truncated(): boolean {
    return this.droppedEntries > 0;
  }

  get droppedEntryCount(): number {
    return this.droppedEntries;
  }

  get droppedByteCount(): number {
    return this.droppedBytes;
  }

  append(
    direction: "request" | "response",
    chunk: Uint8Array,
    observedAtNs: bigint = process.hrtime.bigint(),
  ): ChunkManifestEntry | undefined {
    if (observedAtNs < this.lastObservedNs) {
      throw new RangeError("Chunk monotonic time cannot move backward.");
    }

    if (this.entries.length >= this.maximumEntries) {
      this.droppedEntries += 1;
      this.droppedBytes += chunk.byteLength;
      this.lastObservedNs = observedAtNs;
      return undefined;
    }

    const entry = ChunkManifestEntrySchema.parse({
      sequence: this.entries.length + 1,
      direction,
      monotonicOffsetNs: (observedAtNs - this.startedMonotonicNs).toString(),
      byteOffset: this.offsets[direction],
      byteLength: chunk.byteLength,
      sha256: createHash("sha256").update(chunk).digest("hex"),
    });
    this.entries.push(entry);
    this.offsets[direction] += chunk.byteLength;
    this.lastObservedNs = observedAtNs;
    return entry;
  }

  build(completed: boolean): ChunkManifest {
    return ChunkManifestSchema.parse({
      schemaVersion: 1,
      exchangeId: this.exchangeId,
      startedMonotonicNs: this.startedMonotonicNs.toString(),
      completed,
      truncated: this.truncated,
      droppedEntryCount: this.droppedEntries,
      droppedByteCount: this.droppedBytes,
      entries: this.entries,
    });
  }

  async persist(blobStore: BlobStore, completed: boolean) {
    const manifest = this.build(completed);
    return blobStore.put(JSON.stringify(manifest), {
      mediaType: "application/vnd.tekrion.chunk-manifest+json",
    });
  }
}
