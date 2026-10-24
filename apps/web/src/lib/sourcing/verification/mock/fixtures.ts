import type { AssessmentMetadata, VisualMatchAssessment } from "../../domain";

/**
 * SYNTHETIC FIXTURE DATA. Every assessment below was written by hand to
 * exercise pipeline behaviour. The similarity values are arbitrary example
 * numbers: they were not produced by a model or a similarity algorithm and
 * say nothing about real matching accuracy. Classifications describe visual
 * design only, never manufacturer or SKU identity.
 */

export const SYNTHETIC_ASSESSMENT_METADATA: AssessmentMetadata = {
  dataSource: "mock",
  method: "fixture",
  notes:
    "Synthetic assessment with a predefined example value. Not model-generated; not a measurement.",
};

const ASSESSED_AT = "2026-01-01T00:00:00.000Z";

export const MOCK_ASSESSMENTS: readonly VisualMatchAssessment[] = [
  // Chair reference
  {
    id: "mock-assessment-chair-001",
    referenceImageId: "mock-ref-chair-001",
    fingerprintId: "mock-fp-chair-001",
    listingId: "mock-listing-001",
    classification: "exact_visual_design",
    designSimilarityIndex: 94,
    confidence: "medium",
    supportingEvidence: [
      { feature: "back_shape", description: "Synthetic example: curved backrest in both." },
      { feature: "frame_colour", description: "Synthetic example: black frame in both." },
    ],
    differences: [],
    unverifiableFeatures: ["wood_species"],
    assessedAt: ASSESSED_AT,
    metadata: SYNTHETIC_ASSESSMENT_METADATA,
  },
  {
    id: "mock-assessment-chair-002",
    referenceImageId: "mock-ref-chair-001",
    fingerprintId: "mock-fp-chair-001",
    listingId: "mock-listing-002",
    classification: "similar_alternative",
    designSimilarityIndex: 58,
    confidence: "medium",
    supportingEvidence: [
      { feature: "subtype", description: "Synthetic example: both are dining chairs." },
    ],
    differences: [
      { feature: "backrest", description: "Synthetic example: upholstered, not a curved panel." },
    ],
    unverifiableFeatures: [],
    assessedAt: ASSESSED_AT,
    metadata: SYNTHETIC_ASSESSMENT_METADATA,
  },
  {
    id: "mock-assessment-chair-003",
    referenceImageId: "mock-ref-chair-001",
    fingerprintId: "mock-fp-chair-001",
    listingId: "mock-listing-003",
    classification: "insufficient_evidence",
    designSimilarityIndex: null,
    confidence: "low",
    supportingEvidence: [],
    differences: [],
    unverifiableFeatures: ["back_shape", "leg_count"],
    assessedAt: ASSESSED_AT,
    metadata: SYNTHETIC_ASSESSMENT_METADATA,
  },
  // Table reference
  {
    id: "mock-assessment-table-004",
    referenceImageId: "mock-ref-table-001",
    fingerprintId: "mock-fp-table-001",
    listingId: "mock-listing-004",
    classification: "close_variant",
    designSimilarityIndex: 81,
    confidence: "high",
    supportingEvidence: [
      { feature: "base", description: "Synthetic example: central pedestal in both." },
    ],
    differences: [
      { feature: "pedestal", description: "Synthetic example: straight column, not flared." },
    ],
    unverifiableFeatures: ["diameter"],
    assessedAt: ASSESSED_AT,
    metadata: SYNTHETIC_ASSESSMENT_METADATA,
  },
  {
    id: "mock-assessment-table-005",
    referenceImageId: "mock-ref-table-001",
    fingerprintId: "mock-fp-table-001",
    listingId: "mock-listing-005",
    classification: "non_match",
    designSimilarityIndex: 22,
    confidence: "high",
    supportingEvidence: [],
    differences: [
      { feature: "top_shape", description: "Synthetic example: rectangular, not round." },
    ],
    unverifiableFeatures: [],
    assessedAt: ASSESSED_AT,
    metadata: SYNTHETIC_ASSESSMENT_METADATA,
  },
];
