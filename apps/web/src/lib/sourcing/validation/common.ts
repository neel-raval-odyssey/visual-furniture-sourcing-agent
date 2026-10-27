import { z } from "zod";
import type { AcquisitionMethod, DataProvenance, DataSourceKind, ImageRef } from "../domain";
import type { Assert, SchemaMatches } from "./contract";

/**
 * Object policy for all schemas: z.strictObject. Unknown keys are rejected,
 * never silently stripped, so a provider or model adapter that returns fields
 * outside the contract fails loudly. The only open-ended structure in the
 * contracts is CandidateListing.attributes, which is a string record and keeps
 * every key.
 */

export const idSchema = z.string().min(1);

export const nonEmptyStringSchema = z.string().min(1);

/** ISO 8601 date-time with "Z" or a numeric offset, e.g. "+05:30". */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/** Page links that may later be rendered as hyperlinks: http(s) only. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

export const marketplaceIdSchema = nonEmptyStringSchema;

export const dataSourceKindSchema = z.enum(["mock", "live"]);

/** Image references are opaque strings: URLs, storage keys or fixture paths. */
export const imageRefSchema = z.strictObject({
  uri: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema.optional(),
  widthPx: z.int().positive().optional(),
  heightPx: z.int().positive().optional(),
});

export const acquisitionMethodSchema = z.enum(["provider_api", "operator_assisted"]);

export const dataProvenanceSchema = z.strictObject({
  marketplace: marketplaceIdSchema,
  dataSource: dataSourceKindSchema,
  retrievedAt: isoTimestampSchema,
  acquisitionMethod: acquisitionMethodSchema.optional(),
});

export type _ImageRefCheck = Assert<SchemaMatches<typeof imageRefSchema, ImageRef>>;
export type _DataSourceKindCheck = Assert<SchemaMatches<typeof dataSourceKindSchema, DataSourceKind>>;
export type _AcquisitionMethodCheck = Assert<SchemaMatches<typeof acquisitionMethodSchema, AcquisitionMethod>>;
export type _DataProvenanceCheck = Assert<SchemaMatches<typeof dataProvenanceSchema, DataProvenance>>;
