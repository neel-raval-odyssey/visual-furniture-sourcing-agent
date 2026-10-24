import { z } from "zod";
import type { AssessmentMetadata, FeatureEvidence, VisualMatchAssessment } from "../domain";
import {
  dataSourceKindSchema,
  idSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";

export const featureEvidenceSchema = z.strictObject({
  feature: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  listingImageUri: nonEmptyStringSchema.optional(),
});

export const assessmentMetadataSchema = z.strictObject({
  dataSource: dataSourceKindSchema,
  method: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  notes: z.string().optional(),
});

export const visualMatchAssessmentSchema = z.strictObject({
  id: idSchema,
  referenceImageId: idSchema,
  fingerprintId: idSchema.optional(),
  listingId: idSchema,
  classification: z.enum([
    "exact_visual_design",
    "close_variant",
    "similar_alternative",
    "non_match",
    "insufficient_evidence",
  ]),
  /**
   * 0–100 index or null. z.number() already rejects NaN and ±Infinity, and
   * strings are not coerced. Not a probability; no calibration implied.
   */
  designSimilarityIndex: z.number().min(0).max(100).nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  supportingEvidence: z.array(featureEvidenceSchema),
  differences: z.array(featureEvidenceSchema),
  unverifiableFeatures: z.array(nonEmptyStringSchema),
  assessedAt: isoTimestampSchema,
  metadata: assessmentMetadataSchema,
});

export type _FeatureEvidenceCheck = Assert<SchemaMatches<typeof featureEvidenceSchema, FeatureEvidence>>;
export type _AssessmentMetadataCheck = Assert<SchemaMatches<typeof assessmentMetadataSchema, AssessmentMetadata>>;
export type _VisualMatchAssessmentCheck = Assert<SchemaMatches<typeof visualMatchAssessmentSchema, VisualMatchAssessment>>;
