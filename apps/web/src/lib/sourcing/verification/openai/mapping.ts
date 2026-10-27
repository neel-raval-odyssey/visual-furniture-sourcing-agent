import type { AssessmentConfidence, FeatureEvidence, MatchClassification, VisualMatchAssessment } from "../../domain";
import { VisionModelError } from "../../understanding/openai/errors";
import type { RawFeatureComparison, RawVisualVerification } from "./raw-response";

/** Application-owned values. Never taken from model output. */
export interface TrustedAssessmentMetadata {
  assessmentId: string;
  referenceImageId: string;
  fingerprintId: string;
  listingId: string;
  /** Listing image the candidate photograph came from, e.g. "local-evidence:<path>". */
  candidateImageUri: string;
  assessedAt: string;
  modelId: string;
  instructionsVersion: string;
  responseId: string;
}

/** Explicit mapping from the raw labels to the domain enum (identical today, but never implicit). */
const CLASSIFICATIONS: Record<RawVisualVerification["classification"], MatchClassification> = {
  exact_visual_design: "exact_visual_design",
  close_variant: "close_variant",
  similar_alternative: "similar_alternative",
  non_match: "non_match",
  insufficient_evidence: "insufficient_evidence",
};

const CONFIDENCE: Record<RawVisualVerification["confidence"], AssessmentConfidence> = {
  low: "low",
  medium: "medium",
  high: "high",
};

/** Index bounds each classification must respect (the rubric's consistency rules). */
export const CLASSIFICATION_INDEX_BOUNDS: Record<Exclude<MatchClassification, "insufficient_evidence">, [number, number]> = {
  exact_visual_design: [80, 100],
  close_variant: [50, 100],
  similar_alternative: [0, 85],
  non_match: [0, 50],
};

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

function malformed(path: string, problem: string): VisionModelError {
  return new VisionModelError("malformed_output", `Model output is inconsistent at ${path}: ${problem}`);
}

/**
 * Checks rules the Structured Outputs schema cannot express. Throws
 * VisionModelError("malformed_output"); nothing is repaired or defaulted.
 */
export function checkRawVerification(raw: RawVisualVerification): void {
  const cls = raw.classification;
  const index = raw.design_similarity_index;

  if (index !== null && !(Number.isInteger(index) && index >= 0 && index <= 100)) {
    throw malformed("design_similarity_index", "must be an integer from 0 to 100, or null");
  }
  if (cls === "insufficient_evidence") {
    if (index !== null) throw malformed("design_similarity_index", "must be null for insufficient_evidence");
  } else {
    if (index === null) throw malformed("design_similarity_index", `null is only allowed for insufficient_evidence, not ${cls}`);
    const [min, max] = CLASSIFICATION_INDEX_BOUNDS[cls];
    if (index < min || index > max) throw malformed("design_similarity_index", `${index} is outside ${min}-${max} for ${cls}`);
  }

  if (!raw.reference_target.identifiable || !raw.candidate_target.identifiable) {
    if (cls !== "insufficient_evidence") throw malformed("classification", "a target is not identifiable, so it must be insufficient_evidence");
  }
  if (raw.category_comparison === "different_category" && cls !== "non_match" && cls !== "insufficient_evidence") {
    throw malformed("classification", "different categories must be non_match");
  }
  if (!collapse(raw.summary)) throw malformed("summary", "empty");

  if (cls !== "insufficient_evidence") {
    const compared = raw.features.filter((f) => f.comparison !== "not_comparable");
    if (compared.length === 0) throw malformed("features", `${cls} requires at least one compared feature`);
  }
  raw.features.forEach((f, i) => {
    const path = `features[${i}]`;
    if (!collapse(f.feature)) throw malformed(`${path}.feature`, "empty feature name");
    if (!collapse(f.explanation)) throw malformed(`${path}.explanation`, "empty");
    if (f.evidence_basis === "not_visible" && f.comparison !== "not_comparable") {
      throw malformed(`${path}.comparison`, "a not_visible feature must be not_comparable");
    }
    if (f.comparison !== "not_comparable" && (f.reference_observation === null || f.candidate_observation === null)) {
      throw malformed(`${path}`, `a ${f.comparison} needs both a reference and a candidate observation`);
    }
  });
  if (cls === "exact_visual_design") {
    const definingMismatch = raw.features.some((f) => f.importance === "defining" && f.comparison === "mismatch");
    if (definingMismatch) throw malformed("classification", "exact_visual_design with a defining mismatch");
    if (!raw.features.some((f) => f.importance === "defining" && f.comparison === "match")) {
      throw malformed("classification", "exact_visual_design requires a matching defining feature");
    }
  }
}

const toSnake = (text: string) =>
  collapse(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function describe(f: RawFeatureComparison): string {
  const parts = [`[${f.comparison}; ${f.importance}; ${f.aspect}; ${f.evidence_basis}]`];
  if (f.reference_observation) parts.push(`Reference: ${collapse(f.reference_observation)}.`);
  if (f.candidate_observation) parts.push(`Candidate: ${collapse(f.candidate_observation)}.`);
  parts.push(collapse(f.explanation));
  if (f.visibility_limitation) parts.push(`(Limitation: ${collapse(f.visibility_limitation)})`);
  return parts.join(" ");
}

/**
 * Maps a checked raw verification to a VisualMatchAssessment. Matches and
 * partial matches become supportingEvidence, mismatches become differences,
 * and not-comparable features, visibility limits and uncertain claims become
 * unverifiableFeatures. The full raw evidence is kept in the run record.
 */
export function mapRawVerificationToAssessment(raw: RawVisualVerification, trusted: TrustedAssessmentMetadata): VisualMatchAssessment {
  checkRawVerification(raw);
  const evidence = (f: RawFeatureComparison): FeatureEvidence => ({
    feature: toSnake(f.feature) || "feature",
    description: describe(f),
    listingImageUri: trusted.candidateImageUri,
  });
  const unverifiable = [
    ...raw.features.filter((f) => f.comparison === "not_comparable").map((f) => `${toSnake(f.feature)}: ${collapse(f.visibility_limitation ?? f.explanation)}`),
    ...raw.visibility_limitations.map(collapse).filter(Boolean),
    ...raw.uncertain_claims.map((c) => collapse(c)).filter(Boolean).map((c) => `uncertain: ${c}`),
  ];
  return {
    id: trusted.assessmentId,
    referenceImageId: trusted.referenceImageId,
    fingerprintId: trusted.fingerprintId,
    listingId: trusted.listingId,
    classification: CLASSIFICATIONS[raw.classification],
    designSimilarityIndex: raw.design_similarity_index,
    confidence: CONFIDENCE[raw.confidence],
    supportingEvidence: raw.features.filter((f) => f.comparison === "match" || f.comparison === "partial_match").map(evidence),
    differences: raw.features.filter((f) => f.comparison === "mismatch").map(evidence),
    unverifiableFeatures: unverifiable,
    assessedAt: trusted.assessedAt,
    metadata: {
      dataSource: "live",
      method: "multimodal_model",
      modelId: trusted.modelId,
      notes: `Pairwise visual verification; instructions ${trusted.instructionsVersion}; response ${trusted.responseId}. ${collapse(raw.summary)}`,
    },
  };
}
