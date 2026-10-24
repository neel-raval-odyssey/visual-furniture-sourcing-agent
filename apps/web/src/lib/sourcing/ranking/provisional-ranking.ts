import type {
  CandidateListing,
  MatchClassification,
  RankedSourcingResult,
  SupplierProfile,
  VisualMatchAssessment,
} from "../domain";
import type { RankingRequest, SourcingRankingService } from "./types";

/**
 * PROVISIONAL policy for exercising orchestration and sorting only. It is not
 * the production ranking algorithm. Order:
 *   1. classification bucket (below; unassessed listings last);
 *   2. designSimilarityIndex, highest first, with null after any number;
 *   3. listing id, ascending, as a deterministic tie-breaker.
 * No weights, confidence calibration or supplier signals are applied.
 */
export const PROVISIONAL_CLASSIFICATION_ORDER: readonly MatchClassification[] = [
  "exact_visual_design",
  "close_variant",
  "similar_alternative",
  "insufficient_evidence",
  "non_match",
];

const UNASSESSED_BUCKET = PROVISIONAL_CLASSIFICATION_ORDER.length;

export class ProvisionalRankingService implements SourcingRankingService {
  async rank(request: RankingRequest): Promise<RankedSourcingResult[]> {
    const suppliersById = new Map(request.suppliers.map((s) => [s.id, s]));
    const assessmentsByListing = new Map<string, VisualMatchAssessment>();
    for (const assessment of request.assessments) {
      if (assessmentsByListing.has(assessment.listingId)) {
        throw new Error(
          `Multiple assessments for listing "${assessment.listingId}"`,
        );
      }
      assessmentsByListing.set(assessment.listingId, assessment);
    }

    const rows = request.listings.map((listing) => ({
      listing,
      supplier: listing.supplierId
        ? suppliersById.get(listing.supplierId)
        : undefined,
      assessment: assessmentsByListing.get(listing.id),
    }));

    rows.sort(compareRows);

    return rows.map((row, index) => toResult(row, index + 1));
  }
}

interface Row {
  listing: CandidateListing;
  supplier?: SupplierProfile;
  assessment?: VisualMatchAssessment;
}

function bucket(assessment: VisualMatchAssessment | undefined): number {
  return assessment
    ? PROVISIONAL_CLASSIFICATION_ORDER.indexOf(assessment.classification)
    : UNASSESSED_BUCKET;
}

function compareRows(a: Row, b: Row): number {
  const byBucket = bucket(a.assessment) - bucket(b.assessment);
  if (byBucket !== 0) return byBucket;

  const simA = a.assessment?.designSimilarityIndex ?? null;
  const simB = b.assessment?.designSimilarityIndex ?? null;
  if (simA !== simB) {
    if (simA === null) return 1;
    if (simB === null) return -1;
    return simB - simA;
  }

  if (a.listing.id === b.listing.id) return 0;
  return a.listing.id < b.listing.id ? -1 : 1;
}

function toResult(row: Row, rank: number): RankedSourcingResult {
  const result: RankedSourcingResult = {
    listing: structuredClone(row.listing),
    rank,
  };
  if (row.supplier) result.supplier = structuredClone(row.supplier);
  if (row.assessment) result.assessment = structuredClone(row.assessment);
  return result;
}
