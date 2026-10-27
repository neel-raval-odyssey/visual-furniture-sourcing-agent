import { describe, expect, it } from "vitest";
import { VisionModelError } from "../../understanding/openai/errors";
import { visualMatchAssessmentSchema } from "../../validation/assessment";
import { checkRawVerification, mapRawVerificationToAssessment, type TrustedAssessmentMetadata } from "./mapping";
import { rawVisualVerificationSchema, type RawVisualVerification } from "./raw-response";
import { syntheticRawVerification } from "./test-fixtures";

const trusted: TrustedAssessmentMetadata = {
  assessmentId: "va-test-1",
  referenceImageId: "ref-test",
  fingerprintId: "fp-test",
  listingId: "alibaba-product-0000000001",
  candidateImageUri: "local-evidence:case/a.png",
  assessedAt: "2026-10-26T12:00:00.000Z",
  modelId: "gpt-6.1-sol-2026-10-01",
  instructionsVersion: "2026-10-26.1",
  responseId: "resp_test_123",
};

const rejects = (raw: RawVisualVerification, pattern: RegExp) => {
  expect(() => checkRawVerification(raw)).toThrow(VisionModelError);
  expect(() => checkRawVerification(raw)).toThrow(pattern);
};

describe("raw verification schema", () => {
  it("rejects unknown classifications and missing evidence fields", () => {
    expect(rawVisualVerificationSchema.safeParse({ ...syntheticRawVerification(), classification: "likely_same" }).success).toBe(false);
    const noFeatures: Record<string, unknown> = { ...syntheticRawVerification() };
    delete noFeatures.features;
    expect(rawVisualVerificationSchema.safeParse(noFeatures).success).toBe(false);
    expect(rawVisualVerificationSchema.safeParse({ ...syntheticRawVerification(), listing_id: "x" }).success).toBe(false);
  });
});

describe("mapping raw verification to VisualMatchAssessment", () => {
  it("maps a consistent result with application-owned provenance", () => {
    const a = mapRawVerificationToAssessment(syntheticRawVerification(), trusted);
    expect(visualMatchAssessmentSchema.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      id: "va-test-1",
      referenceImageId: "ref-test",
      fingerprintId: "fp-test",
      listingId: "alibaba-product-0000000001",
      classification: "close_variant",
      designSimilarityIndex: 78,
      confidence: "medium",
      assessedAt: "2026-10-26T12:00:00.000Z",
      metadata: { dataSource: "live", method: "multimodal_model", modelId: "gpt-6.1-sol-2026-10-01" },
    });
    expect(a.metadata.notes).toContain("instructions 2026-10-26.1; response resp_test_123");
    expect(a.supportingEvidence.map((e) => e.feature)).toEqual(["headboard_arch_count", "headboard_top_rail"]);
    expect(a.supportingEvidence[0].description).toMatch(/^\[partial_match; defining; structural_geometry; observed\] Reference: \[TEST\] seven/);
    expect(a.supportingEvidence[0].listingImageUri).toBe("local-evidence:case/a.png");
    expect(a.differences.map((e) => e.feature)).toEqual(["leg_profile"]);
    expect(a.unverifiableFeatures).toEqual([
      "side_rails: [TEST] Covered by bedding",
      "[TEST] Candidate photographed in a furnished room",
      "uncertain: [TEST] Finish sheen",
    ]);
  });

  it("allows abstention: insufficient_evidence with a null index", () => {
    const raw = syntheticRawVerification({
      candidate_target: { identifiable: false, category: null, note: "[TEST] Bed mostly out of frame" },
      classification: "insufficient_evidence",
      design_similarity_index: null,
      confidence: "low",
      features: [],
    });
    const a = mapRawVerificationToAssessment(raw, trusted);
    expect(a).toMatchObject({ classification: "insufficient_evidence", designSimilarityIndex: null, supportingEvidence: [], differences: [] });
  });

  it("rejects invalid similarity values", () => {
    for (const v of [101, -1, 72.5]) rejects(syntheticRawVerification({ design_similarity_index: v }), /integer from 0 to 100/);
    rejects(syntheticRawVerification({ design_similarity_index: null }), /null is only allowed for insufficient_evidence/);
    rejects(syntheticRawVerification({ classification: "insufficient_evidence", design_similarity_index: 40 }), /must be null/);
  });

  it("rejects classifications inconsistent with the index or the evidence", () => {
    rejects(syntheticRawVerification({ classification: "non_match", design_similarity_index: 78 }), /outside 0-50 for non_match/);
    rejects(syntheticRawVerification({ classification: "exact_visual_design", design_similarity_index: 60 }), /outside 80-100/);
    rejects(
      syntheticRawVerification({ classification: "exact_visual_design", design_similarity_index: 95, features: syntheticRawVerification().features.map((f) => (f.importance === "defining" ? { ...f, comparison: "mismatch" as const } : f)) }),
      /defining mismatch/,
    );
    rejects(syntheticRawVerification({ category_comparison: "different_category" }), /must be non_match/);
    rejects(syntheticRawVerification({ reference_target: { identifiable: false, category: null, note: "x" } }), /not identifiable/);
  });

  it("rejects evidence that claims to compare hidden or unobserved parts", () => {
    const features = syntheticRawVerification().features;
    rejects(syntheticRawVerification({ features: [{ ...features[3], comparison: "match" }] }), /not_visible feature must be not_comparable/);
    rejects(syntheticRawVerification({ features: [{ ...features[0], candidate_observation: null }] }), /needs both a reference and a candidate observation/);
    rejects(syntheticRawVerification({ features: [features[3]] }), /requires at least one compared feature/);
    rejects(syntheticRawVerification({ summary: "  " }), /summary/);
  });
});
