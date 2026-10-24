import { describe, expect, it } from "vitest";
import { MOCK_REFERENCE_IMAGES } from "../understanding/mock/fixtures";
import type { SourcingPipelineResult } from "./sourcing-pipeline";
import { summarizeSourcingRun } from "./summary";
import { createSyntheticSourcingPipeline } from "./synthetic";

const FIXED_NOW = () => new Date("2026-10-24T10:00:00.000Z");

describe("summarizeSourcingRun", () => {
  it("summarizes ranked results with similarity and confidence kept separate", async () => {
    const run = await createSyntheticSourcingPipeline({ now: FIXED_NOW }).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
    });
    const summary = summarizeSourcingRun(run);

    expect(summary.referenceImageId).toBe("mock-ref-chair-001");
    expect(summary.discoveredCandidates).toBe(3);
    expect(summary.results[2]).toMatchObject({
      rank: 3,
      classification: "insufficient_evidence",
      designSimilarityIndex: null,
      confidence: "low",
      supplier: "Synthetic Supplier Gamma (Mock)",
    });
  });

  it("only flags synthetic data when a stage reports it", async () => {
    const run = await createSyntheticSourcingPipeline({ now: FIXED_NOW }).run({
      reference: MOCK_REFERENCE_IMAGES.table,
    });
    const live = { ...run.discovery.provider, dataSource: "live" as const };
    const liveListings = run.discovery.listings.map((l) => ({
      ...l,
      provenance: { ...l.provenance, dataSource: "live" as const },
    }));
    const liveLike: SourcingPipelineResult = {
      ...run,
      fingerprint: { ...run.fingerprint, source: { kind: "model", dataSource: "live", modelId: "example" } },
      discovery: {
        ...run.discovery,
        provider: live,
        listings: liveListings,
        suppliers: run.discovery.suppliers.map((s) => ({
          ...s,
          provenance: { ...s.provenance, dataSource: "live" as const },
        })),
      },
      assessments: run.assessments.map((a) => ({ ...a, metadata: { dataSource: "live", method: "multimodal_model", modelId: "example" } })),
    };
    const oneMockListing: SourcingPipelineResult = {
      ...liveLike,
      discovery: { ...liveLike.discovery, listings: [run.discovery.listings[0], ...liveListings.slice(1)] },
    };

    expect(summarizeSourcingRun(run).containsSyntheticData).toBe(true);
    expect(summarizeSourcingRun(liveLike).containsSyntheticData).toBe(false);
    expect(summarizeSourcingRun(oneMockListing).containsSyntheticData).toBe(true);
  });

  it("reports unassessed results without inventing values", async () => {
    const run = await createSyntheticSourcingPipeline({ now: FIXED_NOW }).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
    });
    const [first] = run.results;
    const summary = summarizeSourcingRun({
      ...run,
      results: [{ listing: first.listing, rank: 1 }],
    });

    expect(summary.results[0]).toMatchObject({
      classification: "unassessed",
      designSimilarityIndex: null,
      confidence: null,
      supplier: null,
    });
  });
});
