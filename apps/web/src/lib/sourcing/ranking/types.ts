import type {
  CandidateListing,
  RankedSourcingResult,
  SupplierProfile,
  VisualMatchAssessment,
} from "../domain";

export interface RankingRequest {
  listings: readonly CandidateListing[];
  suppliers: readonly SupplierProfile[];
  /** At most one per listing. Listings without one are ranked as unassessed. */
  assessments: readonly VisualMatchAssessment[];
}

/**
 * Boundary for ordering candidates into user-facing results. Ranking uses
 * the assessments it is given; it never performs inference or recomputes
 * similarity, and it returns exactly one result per listing.
 */
export interface SourcingRankingService {
  rank(request: RankingRequest): Promise<RankedSourcingResult[]>;
}
