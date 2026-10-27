import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import { liveShapedManifest, liveShapedRunRecord, syntheticManifest, syntheticRunRecord } from "../discovery/curated/test-fixtures";
import { savedFingerprintFromRecord } from "../understanding/saved/saved-fingerprint";
import { createCuratedSourcingPipeline } from "./curated";
import { SourcingPipelineError } from "./errors";
import { summarizeSourcingRun } from "./summary";

afterEach(() => {
  vi.unstubAllGlobals();
});

const liveShapedSaved = () => savedFingerprintFromRecord(liveShapedRunRecord(), "test-live-bed");

describe("curated sourcing pipeline", () => {
  it("combines a saved fingerprint with curated candidates through the existing stage boundaries", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const saved = liveShapedSaved();
    const { pipeline } = createCuratedSourcingPipeline({
      fingerprint: saved.fingerprint,
      manifests: [candidateManifestSchema.parse(liveShapedManifest())],
    });

    const run = await pipeline.run({ reference: saved.reference });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run.fingerprint).toEqual(saved.fingerprint);
    expect(run.discovery.listings).toHaveLength(1);
    expect(run.assessments).toEqual([]);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].assessment).toBeUndefined();
    expect(run.results[0].supplier?.id).toBe(run.results[0].listing.supplierId);

    const summary = summarizeSourcingRun(run);
    expect(summary.containsSyntheticData).toBe(false);
    expect(summary.dataSources).toMatchObject({ fingerprint: "live", discovery: "live", marketplaceRecords: ["live"], assessments: [] });
    expect(summary.results[0]).toMatchObject({ classification: "unassessed", designSimilarityIndex: null, confidence: null });
  });

  it("labels synthetic candidates as synthetic and never invents assessments", async () => {
    const saved = savedFingerprintFromRecord(syntheticRunRecord(), "syn-bed-001");
    const { pipeline } = createCuratedSourcingPipeline({
      fingerprint: saved.fingerprint,
      manifests: [candidateManifestSchema.parse(syntheticManifest())],
    });
    const run = await pipeline.run({ reference: saved.reference, discovery: { limit: 2 } });
    const summary = summarizeSourcingRun(run);
    expect(summary.containsSyntheticData).toBe(true);
    expect(run.results.every((r) => r.assessment === undefined)).toBe(true);
    expect(summary.results.map((r) => r.designSimilarityIndex)).toEqual([null, null]);
  });

  it("reports a manifest prepared from another fingerprint as a discovery-stage error", async () => {
    const saved = savedFingerprintFromRecord(syntheticRunRecord(), "syn-bed-001");
    const { pipeline } = createCuratedSourcingPipeline({
      fingerprint: saved.fingerprint,
      manifests: [candidateManifestSchema.parse(syntheticManifest({ fingerprintId: "fp-stale" }))],
    });
    const error = await pipeline.run({ reference: saved.reference }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourcingPipelineError);
    expect((error as SourcingPipelineError).stage).toBe("candidate_discovery");
  });
});
