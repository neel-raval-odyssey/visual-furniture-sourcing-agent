import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MOCK_LISTINGS } from "../discovery/mock/fixtures";
import { MockAlibabaDiscoveryAdapter } from "../discovery/mock/mock-alibaba-adapter";
import type { DiscoverySearchResult } from "../discovery/types";
import type { VisualMatchAssessment } from "../domain";
import { ProvisionalRankingService } from "../ranking/provisional-ranking";
import { MOCK_FINGERPRINTS, MOCK_REFERENCE_IMAGES } from "../understanding/mock/fixtures";
import { MockImageUnderstandingService } from "../understanding/mock/mock-image-understanding";
import { MOCK_ASSESSMENTS } from "../verification/mock/fixtures";
import { MockVisualVerificationService } from "../verification/mock/mock-visual-verification";
import { SourcingPipelineError, type PipelineStage } from "./errors";
import { SourcingPipeline, type SourcingPipelineDependencies } from "./sourcing-pipeline";
import { summarizeSourcingRun } from "./summary";

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles return malformed runtime data on purpose */

const FIXED_NOW = new Date("2026-10-24T10:00:00.000Z");
const chair = MOCK_REFERENCE_IMAGES.chair;

function createDeps(overrides: Partial<SourcingPipelineDependencies> = {}) {
  const deps: SourcingPipelineDependencies = {
    imageUnderstanding: new MockImageUnderstandingService(),
    discovery: new MockAlibabaDiscoveryAdapter({ now: () => FIXED_NOW }),
    visualVerification: new MockVisualVerificationService(),
    ranking: new ProvisionalRankingService(),
    ...overrides,
  };
  return {
    deps,
    spies: {
      analyze: vi.spyOn(deps.imageUnderstanding, "analyze"),
      discover: vi.spyOn(deps.discovery, "discoverCandidates"),
      verify: vi.spyOn(deps.visualVerification, "verify"),
      rank: vi.spyOn(deps.ranking, "rank"),
    },
  };
}

/** A service double whose output bypasses the TypeScript contract. */
const returning = (value: unknown) => async () => value as any;

async function failure(promise: Promise<unknown>, stage: PipelineStage) {
  const error = await promise.then(
    () => {
      throw new Error("expected the pipeline to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourcingPipelineError);
  expect((error as SourcingPipelineError).stage).toBe(stage);
  return error as SourcingPipelineError;
}

const clone = <T>(value: T): any => structuredClone(value);

function chairDiscovery(): DiscoverySearchResult {
  return {
    listings: clone(MOCK_LISTINGS.slice(0, 1)),
    suppliers: [],
    provider: { providerId: "stub", marketplace: "alibaba", dataSource: "mock" },
    retrievedAt: FIXED_NOW.toISOString(),
    queriesUsed: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stage boundary validation", () => {
  it("stops at image_understanding on a malformed fingerprint", async () => {
    const fingerprint = clone(MOCK_FINGERPRINTS[0]);
    fingerprint.appearance[1].certainty = "probably";
    const { deps, spies } = createDeps({ imageUnderstanding: { analyze: returning(fingerprint) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "image_understanding");

    expect(error.message).toContain("Output failed validation");
    expect(error.message).toContain("appearance[1].certainty");
    expect(error.cause).toBeInstanceOf(z.ZodError);
    expect(spies.discover).not.toHaveBeenCalled();
  });

  it("rejects fingerprint provenance that is not a typed data source", async () => {
    const fingerprint = clone(MOCK_FINGERPRINTS[0]);
    fingerprint.source = { kind: "model", dataSource: "verified-by-model" };
    const { deps } = createDeps({ imageUnderstanding: { analyze: returning(fingerprint) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "image_understanding");
    expect(error.message).toContain("source.dataSource: invalid_value");
  });

  it("stops at candidate_discovery on a malformed listing", async () => {
    const discovery = chairDiscovery() as any;
    discovery.listings[0].price.min = "28.00";
    const { deps, spies } = createDeps({ discovery: { discoverCandidates: returning(discovery) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "candidate_discovery");

    expect(error.message).toContain("listings[0].price.min: invalid_type");
    expect(spies.verify).not.toHaveBeenCalled();
    expect(spies.rank).not.toHaveBeenCalled();
  });

  it("does not turn a missing provider response into an empty result", async () => {
    const { deps } = createDeps({ discovery: { discoverCandidates: returning(undefined) } });
    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "candidate_discovery");
    expect(error.message).toContain("(root): invalid_type");
  });

  it("still succeeds for a valid empty discovery result", async () => {
    const empty = { ...chairDiscovery(), listings: [] };
    const { deps, spies } = createDeps({ discovery: { discoverCandidates: returning(empty) } });

    const run = await new SourcingPipeline(deps).run({ reference: chair });

    expect(run.discovery.listings).toEqual([]);
    expect(run.assessments).toEqual([]);
    expect(run.results).toEqual([]);
    expect(spies.verify).not.toHaveBeenCalled();
  });

  it.each<[string, (a: any) => void, string]>([
    ["similarity above 100", (a) => (a.designSimilarityIndex = 145), "[0].designSimilarityIndex: too_big"],
    ["similarity as a string", (a) => (a.designSimilarityIndex = "94"), "[0].designSimilarityIndex: invalid_type"],
    ["an invalid classification", (a) => (a.classification = "same_product"), "[0].classification: invalid_value"],
    ["missing provenance", (a) => delete a.metadata, "[0].metadata: invalid_type"],
    ["an unexpected raw model field", (a) => (a.rawResponse = "{...}"), "[0]: unrecognized_keys"],
  ])("stops at visual_verification on %s", async (_name, mutate, expectedIssue) => {
    const assessment = clone(MOCK_ASSESSMENTS[0]);
    mutate(assessment);
    const { deps, spies } = createDeps({ visualVerification: { verify: returning([assessment]) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "visual_verification");

    expect(error.message).toContain(expectedIssue);
    expect(error.cause).toBeInstanceOf(z.ZodError);
    expect(spies.rank).not.toHaveBeenCalled();
  });

  it("stops at ranking on malformed ranked results", async () => {
    const real = new ProvisionalRankingService();
    const malformed = {
      rank: async (request: Parameters<typeof real.rank>[0]) => {
        const results = clone(await real.rank(request));
        results[0].rank = "1";
        return results;
      },
    };
    const { deps } = createDeps({ ranking: malformed });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "ranking");
    expect(error.message).toContain("[0].rank: invalid_type");
  });

  it("keeps integrity checks separate from structural validation", async () => {
    // Structurally valid, but refers to a listing that was not discovered.
    const stray: VisualMatchAssessment = { ...clone(MOCK_ASSESSMENTS[0]), listingId: "mock-listing-005" };
    const { deps } = createDeps({ visualVerification: { verify: returning([stray]) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "visual_verification");

    expect(error.message).toMatch(/unknown listing "mock-listing-005"/);
    expect(error.cause).toBeUndefined();
  });

  it("does not include payload values in validation errors", async () => {
    const discovery = chairDiscovery() as any;
    discovery.listings[0].title = "secret-title-value";
    discovery.listings[0].images[0] = { uri: "https://private.example.com/secret-image.jpg", widthPx: -5 };
    const { deps } = createDeps({ discovery: { discoverCandidates: returning(discovery) } });

    const error = await failure(new SourcingPipeline(deps).run({ reference: chair }), "candidate_discovery");

    expect(error.message).toContain("listings[0].images[0].widthPx: too_small");
    expect(error.message).not.toContain("secret");
  });
});

describe("provenance", () => {
  it("marks every synthetic stage output with a typed mock data source", async () => {
    const run = await new SourcingPipeline(createDeps().deps).run({ reference: chair });

    expect(run.fingerprint.source).toEqual({ kind: "fixture", dataSource: "mock" });
    expect(run.discovery.provider.dataSource).toBe("mock");
    expect(run.discovery.listings.every((l) => l.provenance.dataSource === "mock")).toBe(true);
    expect(run.discovery.suppliers.every((s) => s.provenance.dataSource === "mock")).toBe(true);
    for (const a of run.assessments) {
      expect(a.metadata.dataSource).toBe("mock");
      expect(a.metadata.method).toBe("fixture");
      expect(a.metadata.modelId).toBeUndefined();
    }

    expect(summarizeSourcingRun(run)).toMatchObject({
      containsSyntheticData: true,
      dataSources: {
        fingerprint: "mock",
        fingerprintMethod: "fixture",
        discovery: "mock",
        marketplaceRecords: ["mock"],
        assessments: ["mock"],
        assessmentMethods: ["fixture"],
      },
    });
  });
});

describe("regression", () => {
  it("keeps the chair and table orderings and classifications unchanged", async () => {
    const pipeline = new SourcingPipeline(createDeps().deps);
    const order = async (reference: typeof chair | typeof MOCK_REFERENCE_IMAGES.table) =>
      (await pipeline.run({ reference })).results.map((r) => [
        r.rank,
        r.listing.id,
        r.assessment?.classification,
        r.assessment?.designSimilarityIndex,
      ]);

    expect(await order(chair)).toEqual([
      [1, "mock-listing-001", "exact_visual_design", 94],
      [2, "mock-listing-002", "similar_alternative", 58],
      [3, "mock-listing-003", "insufficient_evidence", null],
    ]);
    expect(await order(MOCK_REFERENCE_IMAGES.table)).toEqual([
      [1, "mock-listing-004", "close_variant", 81],
      [2, "mock-listing-005", "non_match", 22],
    ]);
  });
});
