import type { VisualMatchAssessment } from "./assessment";
import type { CandidateListing } from "./listing";
import type { SupplierProfile } from "./supplier";

/**
 * A user-facing result row. Every association other than the listing is
 * optional so discovery output can be represented before matching or
 * ranking has run.
 */
export interface RankedSourcingResult {
  listing: CandidateListing;
  supplier?: SupplierProfile;
  assessment?: VisualMatchAssessment;
  /** 1-based position once ranked. */
  rank?: number;
}
