import type {
  CandidateListing,
  FurnitureFingerprint,
  ReferenceImage,
  VisualMatchAssessment,
} from "../domain";

export interface VisualVerificationRequest {
  reference: ReferenceImage;
  fingerprint: FurnitureFingerprint;
  /** The candidates to assess. Verification never fetches others. */
  listings: readonly CandidateListing[];
}

/**
 * Boundary for assessing the visual relationship between a reference design
 * and the candidates it is given. It does not search, change listings,
 * enrich suppliers or rank results.
 *
 * Implementations return at most one assessment per listing, and only for
 * listings in the request. A listing with no assessment is left unassessed;
 * implementations must not fabricate one.
 */
export interface VisualVerificationService {
  verify(request: VisualVerificationRequest): Promise<VisualMatchAssessment[]>;
}
