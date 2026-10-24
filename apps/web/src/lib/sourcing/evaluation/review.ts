import { z } from "zod";
import { isoTimestampSchema } from "../validation/common";
import type { EvaluationCase } from "./dataset";

/**
 * Human review of one run against its original photograph. Only reviews with
 * status "complete" count towards human-reviewed metrics; anything marked
 * "not_reviewed" is excluded from denominators.
 */

export const FEATURE_JUDGEMENTS = ["captured", "partial", "missed", "contradicted", "not_reviewed"] as const;
export const UNSUPPORTED_ASSERTION_TYPES = [
  "not_visible",
  "too_specific",
  "incorrect_geometry",
  "overconfident_material_or_dimension",
] as const;
export const FAILURE_TAGS = [
  "wrong_object",
  "wrong_category",
  "missed_distinctive_feature",
  "incorrect_geometry",
  "hallucinated_detail",
  "overconfident_material",
  "vague_description",
  "poor_search_queries",
  "incorrect_rejection",
  "other",
] as const;

const optionalNote = z.string().trim().min(1).optional();
const flag = z.boolean().nullable();

export const reviewRecordSchema = z
  .strictObject({
    recordType: z.literal("image_understanding_review"),
    schemaVersion: z.literal(1),
    caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Response this review judged; a later re-run makes the review stale. */
    responseId: z.string().min(1).nullable(),
    status: z.enum(["in_progress", "complete"]),
    reviewer: z.string().trim().min(1).nullable(),
    reviewedAt: isoTimestampSchema.nullable(),
    objectSelection: z.enum(["correct", "wrong_object", "genuinely_ambiguous", "not_applicable", "not_reviewed"]),
    features: z.array(
      z.strictObject({
        featureId: z.string().min(1),
        judgement: z.enum(FEATURE_JUDGEMENTS),
        note: optionalNote,
      }),
    ),
    unsupportedAssertions: z.array(
      z.strictObject({
        /** The model's claim, quoted. */
        claim: z.string().trim().min(1),
        type: z.enum(UNSUPPORTED_ASSERTION_TYPES),
        explanation: z.string().trim().min(1),
      }),
    ),
    uncertainty: z.strictObject({
      judgement: z.enum(["appropriate", "overconfident", "insufficiently_informative", "not_applicable", "not_reviewed"]),
      note: optionalNote,
    }),
    searchQueries: z.strictObject({
      /** 1 (useless) to 5 (excellent). Preliminary: not a retrieval measurement. */
      rating: z.int().min(1).max(5).nullable(),
      broadCategoryQueryPresent: flag,
      distinctiveTermsIncluded: flag,
      excessivelyNarrow: flag,
      irrelevantOrFabricatedTerms: flag,
      exploresAlternatives: flag,
      note: optionalNote,
    }),
    failureTags: z.array(z.enum(FAILURE_TAGS)),
    notes: z.string(),
  })
  .superRefine((r, ctx) => {
    if (r.status === "complete") {
      if (!r.reviewer) ctx.addIssue({ code: "custom", path: ["reviewer"], message: "A complete review needs a reviewer" });
      if (!r.reviewedAt) ctx.addIssue({ code: "custom", path: ["reviewedAt"], message: "A complete review needs reviewedAt" });
    }
    const ids = r.features.map((f) => f.featureId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) ctx.addIssue({ code: "custom", path: ["features"], message: `Duplicate featureId "${duplicate}"` });
  });

export type ReviewRecord = z.output<typeof reviewRecordSchema>;

/** A blank review for a case: every judgement "not_reviewed", nothing filled in. */
export function createReviewSkeleton(c: EvaluationCase, responseId: string | null): ReviewRecord {
  const furniture = c.expected.outcome === "furniture_identified";
  return {
    recordType: "image_understanding_review",
    schemaVersion: 1,
    caseId: c.id,
    responseId,
    status: "in_progress",
    reviewer: null,
    reviewedAt: null,
    objectSelection: "not_reviewed",
    features:
      c.expected.outcome === "furniture_identified"
        ? c.expected.features.map((f) => ({ featureId: f.id, judgement: "not_reviewed" as const }))
        : [],
    unsupportedAssertions: [],
    uncertainty: { judgement: furniture ? "not_reviewed" : "not_applicable" },
    searchQueries: {
      rating: null,
      broadCategoryQueryPresent: null,
      distinctiveTermsIncluded: null,
      excessivelyNarrow: null,
      irrelevantOrFabricatedTerms: null,
      exploresAlternatives: null,
    },
    failureTags: [],
    notes: "",
  };
}
