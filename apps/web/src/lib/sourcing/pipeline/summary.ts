import type { SourcingPipelineResult } from "./sourcing-pipeline";

export interface SourcingRunSummary {
  /** True when any stage output came from fixtures or mock providers. */
  containsSyntheticData: boolean;
  dataSources: {
    fingerprint: string;
    discovery: string;
    discoveryProvider: string;
    assessmentMethods: string[];
  };
  referenceImageId: string;
  category: string;
  discoveredCandidates: number;
  results: {
    rank: number | null;
    listingId: string;
    title: string;
    classification: string;
    /** Copied from the assessment; null when unscored or unassessed. */
    designSimilarityIndex: number | null;
    confidence: string | null;
    supplier: string | null;
  }[];
}

/** A compact, JSON-friendly view of a pipeline run for logs and demos. */
export function summarizeSourcingRun(run: SourcingPipelineResult): SourcingRunSummary {
  const assessmentMethods = [
    ...new Set(run.assessments.map((a) => a.metadata?.method ?? "unspecified")),
  ].sort();

  return {
    containsSyntheticData:
      run.fingerprint.source.kind === "fixture" ||
      run.discovery.provider.dataSource === "mock" ||
      assessmentMethods.includes("fixture"),
    dataSources: {
      fingerprint: run.fingerprint.source.kind,
      discovery: run.discovery.provider.dataSource,
      discoveryProvider: run.discovery.provider.providerId,
      assessmentMethods,
    },
    referenceImageId: run.reference.id,
    category: run.fingerprint.category,
    discoveredCandidates: run.discovery.listings.length,
    results: run.results.map((r) => ({
      rank: r.rank ?? null,
      listingId: r.listing.id,
      title: r.listing.title,
      classification: r.assessment?.classification ?? "unassessed",
      designSimilarityIndex: r.assessment?.designSimilarityIndex ?? null,
      confidence: r.assessment?.confidence ?? null,
      supplier: r.supplier?.name ?? null,
    })),
  };
}
