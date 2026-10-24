import { z } from "zod";
import type { FingerprintSource, FurnitureFeature, FurnitureFingerprint } from "../domain";
import {
  dataSourceKindSchema,
  idSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";

const featureBase = {
  attribute: nonEmptyStringSchema,
  rationale: z.string().optional(),
};

/**
 * Discriminated on `certainty`. An "unknown" feature has no `value` key at
 * all (strict object), so a fabricated value is rejected rather than dropped.
 * Certainty strings are matched exactly; nothing is coerced.
 */
export const furnitureFeatureSchema = z.discriminatedUnion("certainty", [
  z.strictObject({ ...featureBase, certainty: z.literal("observed"), value: nonEmptyStringSchema }),
  z.strictObject({ ...featureBase, certainty: z.literal("inferred"), value: nonEmptyStringSchema }),
  z.strictObject({ ...featureBase, certainty: z.literal("unknown") }),
]);

export const fingerprintSourceSchema = z.strictObject({
  kind: z.enum(["manual", "model", "fixture"]),
  dataSource: dataSourceKindSchema,
  modelId: nonEmptyStringSchema.optional(),
});

export const furnitureFingerprintSchema = z.strictObject({
  id: idSchema,
  referenceImageIds: z.tuple([idSchema], idSchema),
  category: nonEmptyStringSchema,
  subtype: nonEmptyStringSchema.optional(),
  structure: z.array(furnitureFeatureSchema),
  appearance: z.array(furnitureFeatureSchema),
  distinctiveFeatures: z.array(furnitureFeatureSchema),
  searchQueries: z.array(nonEmptyStringSchema),
  source: fingerprintSourceSchema,
  createdAt: isoTimestampSchema,
});

export type _FurnitureFeatureCheck = Assert<SchemaMatches<typeof furnitureFeatureSchema, FurnitureFeature>>;
export type _FingerprintSourceCheck = Assert<SchemaMatches<typeof fingerprintSourceSchema, FingerprintSource>>;
export type _FurnitureFingerprintCheck = Assert<SchemaMatches<typeof furnitureFingerprintSchema, FurnitureFingerprint>>;
