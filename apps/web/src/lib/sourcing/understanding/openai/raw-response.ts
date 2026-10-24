import { z } from "zod";

/**
 * RAW, UNTRUSTED model output contract for image understanding. This is what
 * the model is asked to produce; it is not a FurnitureFingerprint. It carries
 * no ids, timestamps, model ids or provenance: those are application-owned
 * and assigned during mapping.
 *
 * Written for the Structured Outputs JSON Schema subset: root object, every
 * field required (absence expressed as null), strict objects, no root union,
 * no refinements and no string length constraints. Rules the subset cannot
 * express (e.g. "unknown features have a null value") are enforced in mapping.
 */

export const RAW_ANALYSIS_OUTCOMES = [
  "furniture_identified",
  "no_furniture",
  "ambiguous_target",
  "unreadable_image",
] as const;

export const rawFeatureSchema = z.strictObject({
  attribute: z.string().describe("Short snake_case attribute name, e.g. backrest_shape"),
  certainty: z.enum(["observed", "inferred", "unknown"]),
  value: z
    .string()
    .nullable()
    .describe("Description of what is seen or inferred; null when certainty is unknown"),
  rationale: z
    .string()
    .nullable()
    .describe("Why this is inferred, or why it cannot be determined; null if not needed"),
});

export const rawFurnitureSchema = z.strictObject({
  category: z.string().describe("Furniture category, e.g. chair, table, sofa, bed"),
  subtype: z.string().nullable().describe("More specific type, e.g. dining_chair; null if unclear"),
  structure: z.array(rawFeatureSchema).max(20),
  appearance: z.array(rawFeatureSchema).max(20),
  distinctive_features: z.array(rawFeatureSchema).max(10),
  search_queries: z.array(z.string()).max(8),
});

export const rawVisionAnalysisSchema = z.strictObject({
  outcome: z.enum(RAW_ANALYSIS_OUTCOMES),
  outcome_reason: z.string().describe("One short sentence explaining the outcome"),
  furniture: rawFurnitureSchema
    .nullable()
    .describe("The primary furniture object; null unless outcome is furniture_identified"),
});

export type RawAnalysisOutcome = (typeof RAW_ANALYSIS_OUTCOMES)[number];
export type RawFeature = z.output<typeof rawFeatureSchema>;
export type RawVisionAnalysis = z.output<typeof rawVisionAnalysisSchema>;

/** Name of the structured output format sent to the API. */
export const RAW_VISION_FORMAT_NAME = "furniture_visual_analysis";
