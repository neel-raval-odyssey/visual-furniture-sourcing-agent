import type { IsoTimestamp } from "./common";

/**
 * Visual design match category. These describe design similarity only.
 * "exact_visual_design" means the designs look the same; it does NOT mean the
 * same manufacturer or SKU, which this contract cannot establish.
 */
export type MatchClassification =
  | "exact_visual_design"
  | "close_variant"
  | "similar_alternative"
  | "non_match"
  | "insufficient_evidence";

/** How confident the assessor is in its own assessment. */
export type AssessmentConfidence = "low" | "medium" | "high";

export interface FeatureEvidence {
  /** Attribute being compared, e.g. "leg_style". */
  feature: string;
  description: string;
  /** Listing image the evidence refers to, if specific. */
  listingImageUri?: string;
}

export interface AssessmentMetadata {
  /** e.g. "embedding", "multimodal_model", "manual", "fixture". */
  method: string;
  modelId?: string;
  notes?: string;
}

/**
 * Output of visual verification for one reference/candidate pair. Produced by
 * the matching stage, never by discovery.
 */
export interface VisualMatchAssessment {
  id: string;
  referenceImageId: string;
  fingerprintId?: string;
  listingId: string;
  classification: MatchClassification;
  /**
   * Design similarity on a 0–100 scale. An index, not a calibrated
   * probability. Null when there is too little evidence to score.
   */
  designSimilarityIndex: number | null;
  /** Separate from similarity: a high-similarity result may be low-confidence. */
  confidence: AssessmentConfidence;
  supportingEvidence: FeatureEvidence[];
  differences: FeatureEvidence[];
  /** Features that are obscured or cannot be verified from the images. */
  unverifiableFeatures: string[];
  assessedAt: IsoTimestamp;
  metadata?: AssessmentMetadata;
}
