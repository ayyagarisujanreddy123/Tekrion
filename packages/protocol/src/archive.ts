import { z } from "zod";

import {
  BlobReferenceSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from "./common.js";
import { SessionStatusSchema } from "./session.js";

export const TekrionArchiveProfileSchema = z.enum(["share", "forensic"]);
export const TekrionArchiveFormatSchema = z.enum([
  "tekrion-tkr",
  "blackbox-bbx",
]);

export const TekrionArchiveEntryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._/-]+$/u)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.endsWith("/") &&
      !path
        .split("/")
        .some(
          (segment) => segment === "." || segment === ".." || segment === "",
        ),
    "Archive entry paths must be normalized relative paths.",
  );

export const TekrionArchiveEntryDescriptorSchema = z
  .object({
    path: TekrionArchiveEntryPathSchema,
    mediaType: z.string().trim().min(1).max(256),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
  })
  .strict();

export const TekrionArchiveBlobSchema = z
  .object({
    entryPath: TekrionArchiveEntryPathSchema,
    reference: BlobReferenceSchema,
  })
  .strict();

export const TekrionArchiveRecordCountsSchema = z
  .object({
    sessions: z.literal(1),
    events: z.number().int().nonnegative(),
    rawExchanges: z.number().int().nonnegative(),
    normalizationRuns: z.number().int().nonnegative(),
    fileChanges: z.number().int().nonnegative(),
    contextEdges: z.number().int().nonnegative(),
    analysisRuns: z.number().int().nonnegative(),
    redactions: z.number().int().nonnegative(),
    blobs: z.number().int().nonnegative(),
    reports: z.number().int().nonnegative().max(1),
  })
  .strict();

export const TekrionArchiveManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    format: TekrionArchiveFormatSchema,
    archiveId: IdentifierSchema,
    exportedAt: IsoTimestampSchema,
    profile: TekrionArchiveProfileSchema,
    sourceSessionId: IdentifierSchema,
    sourceSessionStatus: SessionStatusSchema,
    storageSchemaVersion: z.number().int().nonnegative(),
    entries: z.array(TekrionArchiveEntryDescriptorSchema).max(100_000),
    blobs: z.array(TekrionArchiveBlobSchema).max(100_000),
    counts: TekrionArchiveRecordCountsSchema,
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    redaction: z
      .object({
        applied: z.boolean(),
        count: z.number().int().nonnegative(),
        ruleIds: z.array(IdentifierSchema),
      })
      .strict(),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Archive entry paths must be unique.",
      });
    }
    const blobPaths = manifest.blobs.map((blob) => blob.entryPath);
    if (new Set(blobPaths).size !== blobPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["blobs"],
        message: "Archive blob paths must be unique.",
      });
    }
    const entryPaths = new Set(paths);
    if (blobPaths.some((path) => !entryPaths.has(path))) {
      context.addIssue({
        code: "custom",
        path: ["blobs"],
        message: "Every archive blob must reference a declared entry.",
      });
    }
    const byteLength = manifest.entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    if (byteLength !== manifest.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "Archive totalBytes must equal the declared entry sizes.",
      });
    }
    if (manifest.counts.blobs !== manifest.blobs.length) {
      context.addIssue({
        code: "custom",
        path: ["counts", "blobs"],
        message: "Archive blob count does not match the blob manifest.",
      });
    }
  });

export const TekrionArchiveEntrySchema = z
  .object({
    path: TekrionArchiveEntryPathSchema,
    encoding: z.literal("base64"),
    data: z.string().max(750_000_000),
  })
  .strict();

export const TekrionArchiveSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    manifest: TekrionArchiveManifestSchema,
    manifestSha256: Sha256Schema,
    entries: z.array(TekrionArchiveEntrySchema).max(100_000),
  })
  .strict()
  .superRefine((archive, context) => {
    const paths = archive.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Archive payload entry paths must be unique.",
      });
    }
    const declared = archive.manifest.entries.map((entry) => entry.path);
    if (
      paths.length !== declared.length ||
      paths.some((path, index) => path !== declared[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message:
          "Archive payload entries must match manifest order and paths exactly.",
      });
    }
  });

export const TekrionArchiveImportResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    archiveId: IdentifierSchema,
    sessionId: IdentifierSchema,
    profile: TekrionArchiveProfileSchema,
    importedAt: IsoTimestampSchema,
    readOnly: z.literal(true),
    eventCount: z.number().int().nonnegative(),
    blobCount: z.number().int().nonnegative(),
  })
  .strict();

export type TekrionArchive = z.infer<typeof TekrionArchiveSchema>;
export type TekrionArchiveBlob = z.infer<typeof TekrionArchiveBlobSchema>;
export type TekrionArchiveEntry = z.infer<typeof TekrionArchiveEntrySchema>;
export type TekrionArchiveEntryDescriptor = z.infer<
  typeof TekrionArchiveEntryDescriptorSchema
>;
export type TekrionArchiveImportResult = z.infer<
  typeof TekrionArchiveImportResultSchema
>;
export type TekrionArchiveManifest = z.infer<
  typeof TekrionArchiveManifestSchema
>;
export type TekrionArchiveProfile = z.infer<typeof TekrionArchiveProfileSchema>;
