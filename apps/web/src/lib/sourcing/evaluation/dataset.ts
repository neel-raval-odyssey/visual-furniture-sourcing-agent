import { z } from "zod";
import { RAW_ANALYSIS_OUTCOMES } from "../understanding/openai/raw-response";

/**
 * Shareable evaluation dataset: what each photograph should produce, written
 * by a human. Contains no image bytes and no machine-specific paths; local
 * image locations live in a separate, git-ignored mapping file.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lower-case letters, digits and hyphens");
const text = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lower-case hex SHA-256 digest");
/** snake_case, matching how the P0-005 mapping normalises categories. */
const snakeCase = z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, "Use snake_case");

/** The model outcomes from P0-005 (`RawAnalysisOutcome`). */
export const evaluationOutcomeSchema = z.enum(RAW_ANALYSIS_OUTCOMES);
export type EvaluationOutcome = z.output<typeof evaluationOutcomeSchema>;

export const IMAGE_CONDITIONS = [
  "clean_product_photo",
  "lifestyle_photo",
  "multiple_objects",
  "partial_occlusion",
  "unusual_angle",
  "low_resolution",
  "low_light",
  "cropped_furniture",
  "non_furniture",
  "ambiguous_target",
] as const;
export const imageConditionSchema = z.enum(IMAGE_CONDITIONS);

export const imageSourceSchema = z.strictObject({
  kind: z.enum(["retailer_product_photo", "own_photo", "catalogue", "social_media", "licensed_stock", "other"]),
  description: text.optional(),
  /** How the image may be used, e.g. "internal evaluation only". */
  usageNote: text.optional(),
});

export const expectedFeatureSchema = z.strictObject({
  /** Unique within the case; referenced by review records. */
  id: slug,
  description: text,
  priority: z.enum(["critical", "supporting"]),
  aspect: z.enum(["structure", "appearance"]),
  /** Helps tell this design apart from similar products. */
  distinctive: z.boolean(),
});

/**
 * "draft" annotations may be incomplete. "provisional" (one reviewer, not
 * adjudicated) and "adjudicated" annotations of furniture cases need at least
 * one critical feature.
 */
export const annotationStatusSchema = z.enum(["draft", "provisional", "adjudicated"]);

const furnitureExpectation = z.strictObject({
  outcome: z.literal("furniture_identified"),
  category: snakeCase,
  /** Other category names the annotator accepts as correct, e.g. "bed_frame". */
  alsoAcceptableCategories: z.array(snakeCase).default([]),
  /** Human-readable subtype descriptions; compared by a reviewer, not by string matching. */
  acceptableSubtypes: z.array(text).default([]),
  features: z.array(expectedFeatureSchema),
  knownOcclusions: z.array(text).default([]),
  /** Materials, dimensions etc. that cannot be verified from the image. */
  unverifiable: z.array(text).default([]),
  /** Claims a good analysis must NOT make. */
  unsupportedClaims: z.array(text).default([]),
});

const nonFurnitureExpectation = z.strictObject({
  outcome: z.enum(["no_furniture", "ambiguous_target", "unreadable_image"]),
  /** Other outcomes the annotator also accepts, e.g. no_furniture for an unreadable image. */
  alsoAcceptableOutcomes: z.array(evaluationOutcomeSchema).default([]),
  notes: text.optional(),
});

export const evaluationCaseSchema = z
  .strictObject({
    id: slug,
    title: text.optional(),
    /** Composition group, e.g. "bed", "chair", "ambiguous", "non_furniture". */
    group: snakeCase,
    source: imageSourceSchema,
    conditions: z.array(imageConditionSchema).min(1),
    /** Optional fingerprint of the intended image, to detect wrong local files. */
    imageSha256: sha256.optional(),
    annotationStatus: annotationStatusSchema,
    expected: z.discriminatedUnion("outcome", [furnitureExpectation, nonFurnitureExpectation]),
    notes: text.optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    if (new Set(c.conditions).size !== c.conditions.length) issue(["conditions"], "Duplicate condition tags");

    if (c.expected.outcome === "furniture_identified") {
      if (c.conditions.includes("non_furniture")) {
        issue(["conditions"], 'A furniture case cannot be tagged "non_furniture"');
      }
      const ids = c.expected.features.map((f) => f.id);
      const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
      if (duplicate) issue(["expected", "features"], `Duplicate feature id "${duplicate}"`);
      if (c.annotationStatus !== "draft" && !c.expected.features.some((f) => f.priority === "critical")) {
        issue(["expected", "features"], `A ${c.annotationStatus} furniture case needs at least one critical feature`);
      }
      if (c.expected.alsoAcceptableCategories.includes(c.expected.category)) {
        issue(["expected", "alsoAcceptableCategories"], "Repeats the expected category");
      }
    } else if (c.expected.alsoAcceptableOutcomes.includes(c.expected.outcome)) {
      issue(["expected", "alsoAcceptableOutcomes"], "Repeats the expected outcome");
    } else if (c.expected.alsoAcceptableOutcomes.includes("furniture_identified")) {
      issue(["expected", "alsoAcceptableOutcomes"], "A non-furniture case cannot accept furniture_identified");
    }
  });

/** Settings the dataset's baseline was defined against; predictions are checked against it. */
export const evaluationBaselineSchema = z.strictObject({
  model: text,
  instructionsVersion: text,
  imageDetail: text,
  reasoningEffort: text,
  maxOutputTokens: z.int().positive(),
});

export const evaluationDatasetSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    datasetId: slug,
    datasetVersion: text,
    /** "tooling_test" datasets are synthetic and never benchmark results. */
    purpose: z.enum(["benchmark", "tooling_test"]),
    description: text.optional(),
    baseline: evaluationBaselineSchema,
    /** Target number of cases per group; informational. */
    plannedComposition: z.record(snakeCase, z.int().nonnegative()).optional(),
    cases: z.array(evaluationCaseSchema).min(1),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", path: ["cases", i, "id"], message: `Duplicate case id "${c.id}"` });
      seen.add(c.id);
    });
  });

/** Private, git-ignored mapping from case id to a local image path. */
export const localImageMapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  images: z.record(slug, text),
});

export type EvaluationCase = z.output<typeof evaluationCaseSchema>;
export type EvaluationDataset = z.output<typeof evaluationDatasetSchema>;
export type ExpectedFeature = z.output<typeof expectedFeatureSchema>;
export type ImageCondition = z.output<typeof imageConditionSchema>;
export type LocalImageMap = z.output<typeof localImageMapSchema>;

/** Outcomes counted as correct for a case. */
export function acceptableOutcomes(c: EvaluationCase): EvaluationOutcome[] {
  return c.expected.outcome === "furniture_identified"
    ? ["furniture_identified"]
    : [c.expected.outcome, ...c.expected.alsoAcceptableOutcomes];
}
