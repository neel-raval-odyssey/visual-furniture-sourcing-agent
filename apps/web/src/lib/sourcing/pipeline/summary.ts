import type { DataSourceKind } from "../domain";
import type { SourcingPipelineResult } from "./sourcing-pipeline";

export interface SourcingRunSummary {
  /** True when any stage output is marked `dataSource: "mock"`. */
  containsSyntheticData: boolean;
  dataSources: {
    fingerprint: DataSourceKind;
    fingerprintMethod: string;
    discovery: DataSourceKind;
    discoveryProvider: string;
    /** Distinct data sources across listing and supplier provenance. */
    marketplaceRecords: DataSourceKind[];
    assessments: DataSourceKind[];
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

const distinct = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();

/** A compact, JSON-friendly view of a pipeline run for logs and demos. */
export function summarizeSourcingRun(run: SourcingPipelineResult): SourcingRunSummary {
  const dataSources: SourcingRunSummary["dataSources"] = {
    fingerprint: run.fingerprint.source.dataSource,
    fingerprintMethod: run.fingerprint.source.kind,
    discovery: run.discovery.provider.dataSource,
    discoveryProvider: run.discovery.provider.providerId,
    marketplaceRecords: distinct([
      ...run.discovery.listings.map((l) => l.provenance.dataSource),
      ...run.discovery.suppliers.map((s) => s.provenance.dataSource),
    ]),
    assessments: distinct(run.assessments.map((a) => a.metadata.dataSource)),
    assessmentMethods: distinct(run.assessments.map((a) => a.metadata.method)),
  };

  return {
    containsSyntheticData:
      dataSources.fingerprint === "mock" ||
      dataSources.discovery === "mock" ||
      dataSources.marketplaceRecords.includes("mock") ||
      dataSources.assessments.includes("mock"),
    dataSources,
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
