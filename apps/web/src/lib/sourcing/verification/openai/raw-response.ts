import { z } from "zod";

/**
 * RAW, UNTRUSTED model output for pairwise visual verification. It carries no
 * ids, hashes, timestamps or model ids: those are assigned by the adapter.
 *
 * Written for the Structured Outputs JSON Schema subset (every field
 * required, absence as null, strict objects, no refinements). Rules the
 * subset cannot express (index range, classification consistency, evidence
 * consistency) are enforced in mapping.
 */

export const RAW_CLASSIFICATIONS = [
  "exact_visual_design",
  "close_variant",
  "similar_alternative",
  "non_match",
  "insufficient_evidence",
] as const;

const target = z.strictObject({
  identifiable: z.boolean().describe("Whether one primary furniture object is identifiable in this image"),
  category: z.string().nullable().describe("Furniture category, e.g. bed; null if not identifiable"),
  note: z.string().describe("One short sentence about the target in this image"),
});

export const rawFeatureComparisonSchema = z.strictObject({
  feature: z.string().describe("Short snake_case feature name, e.g. headboard_arch_count"),
  aspect: z.enum(["structural_geometry", "silhouette_proportion", "surface_appearance"]),
  importance: z.enum(["defining", "supporting", "minor"]),
  reference_observation: z.string().nullable(),
  candidate_observation: z.string().nullable(),
  comparison: z.enum(["match", "partial_match", "mismatch", "not_comparable"]),
  evidence_basis: z.enum(["observed", "inferred", "not_visible"]),
  visibility_limitation: z.string().nullable(),
  explanation: z.string(),
});

export const rawVisualVerificationSchema = z.strictObject({
  reference_target: target,
  candidate_target: target,
  category_comparison: z.enum(["same_category", "different_category", "cannot_determine"]),
  features: z.array(rawFeatureComparisonSchema).max(24),
  visibility_limitations: z.array(z.string()).max(10),
  uncertain_claims: z.array(z.string()).max(10),
  summary: z.string().describe("Two or three sentences explaining the assessment"),
  classification: z.enum(RAW_CLASSIFICATIONS),
  design_similarity_index: z
    .number()
    .nullable()
    .describe("Integer 0-100 per the rubric; null only for insufficient_evidence"),
  confidence: z.enum(["low", "medium", "high"]),
});

export type RawFeatureComparison = z.output<typeof rawFeatureComparisonSchema>;
export type RawVisualVerification = z.output<typeof rawVisualVerificationSchema>;

/** Name of the structured output format sent to the API. */
export const RAW_VERIFICATION_FORMAT_NAME = "furniture_pairwise_verification";
