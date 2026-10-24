import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_LISTINGS, MOCK_SUPPLIERS } from "../discovery/mock/fixtures";
import { MockAlibabaDiscoveryAdapter } from "../discovery/mock/mock-alibaba-adapter";
import type { DiscoverySearchResult } from "../discovery/types";
import type { ReferenceImage, VisualMatchAssessment } from "../domain";
import { ProvisionalRankingService } from "../ranking/provisional-ranking";
import { MOCK_REFERENCE_IMAGES } from "../understanding/mock/fixtures";
import {
  MockImageUnderstandingService,
  UnsupportedReferenceError,
} from "../understanding/mock/mock-image-understanding";
import { MOCK_ASSESSMENTS } from "../verification/mock/fixtures";
import { MockVisualVerificationService } from "../verification/mock/mock-visual-verification";
import { SourcingPipelineError, type PipelineStage } from "./errors";
import {
  SourcingPipeline,
  type SourcingPipelineDependencies,
  type SourcingPipelineResult,
} from "./sourcing-pipeline";
import { summarizeSourcingRun } from "./summary";

const FIXED_NOW = new Date("2026-10-24T10:00:00.000Z");

function createDeps(
  overrides: Partial<SourcingPipelineDependencies> = {},
): SourcingPipelineDependencies {
  return {
    imageUnderstanding: new MockImageUnderstandingService(),
    discovery: new MockAlibabaDiscoveryAdapter({ now: () => FIXED_NOW }),
    visualVerification: new MockVisualVerificationService(),
    ranking: new ProvisionalRankingService(),
    ...overrides,
  };
}

const rows = (run: SourcingPipelineResult) =>
  run.results.map((r) => ({
    rank: r.rank,
    listingId: r.listing.id,
    classification: r.assessment?.classification,
    supplierId: r.supplier?.id,
  }));

async function expectStageError(
  promise: Promise<unknown>,
  stage: PipelineStage,
): Promise<SourcingPipelineError> {
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

const fixtureListing = (id: string) => {
  const found = MOCK_LISTINGS.find((l) => l.id === id);
  if (!found) throw new Error(`fixture ${id} missing`);
  return structuredClone(found);
};

function discoveryResult(listingIds: string[]): DiscoverySearchResult {
  const listings = listingIds.map(fixtureListing);
  const supplierIds = new Set(listings.flatMap((l) => l.supplierId ?? []));
  return {
    listings,
    suppliers: structuredClone(MOCK_SUPPLIERS.filter((s) => supplierIds.has(s.id))),
    provider: { providerId: "stub", marketplace: "alibaba", dataSource: "mock" },
    retrievedAt: FIXED_NOW.toISOString(),
    queriesUsed: [],
  };
}

const chairAssessment = (overrides: Partial<VisualMatchAssessment>) => ({
  ...structuredClone(MOCK_ASSESSMENTS[0]),
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SourcingPipeline — synthetic workflows", () => {
  it("runs the complete chair workflow", async () => {
    const run = await new SourcingPipeline(createDeps()).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
    });

    expect(run.reference.id).toBe("mock-ref-chair-001");
    expect(run.fingerprint.category).toBe("chair");
    expect(run.discovery.listings.map((l) => l.id)).toEqual([
      "mock-listing-001",
      "mock-listing-002",
      "mock-listing-003",
    ]);
    expect(rows(run)).toEqual([
      { rank: 1, listingId: "mock-listing-001", classification: "exact_visual_design", supplierId: "mock-supplier-001" },
      { rank: 2, listingId: "mock-listing-002", classification: "similar_alternative", supplierId: "mock-supplier-002" },
      { rank: 3, listingId: "mock-listing-003", classification: "insufficient_evidence", supplierId: "mock-supplier-003" },
    ]);
  });

  it("runs the complete table workflow with table candidates only", async () => {
    const run = await new SourcingPipeline(createDeps()).run({
      reference: MOCK_REFERENCE_IMAGES.table,
    });

    expect(run.fingerprint.category).toBe("table");
    expect(run.discovery.listings.every((l) => l.category === "table")).toBe(true);
    expect(rows(run)).toEqual([
      { rank: 1, listingId: "mock-listing-004", classification: "close_variant", supplierId: "mock-supplier-001" },
      { rank: 2, listingId: "mock-listing-005", classification: "non_match", supplierId: "mock-supplier-002" },
    ]);
  });

  it("completes with incomplete product and supplier information", async () => {
    const run = await new SourcingPipeline(createDeps()).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
    });
    const lounge = run.results.find((r) => r.listing.id === "mock-listing-003");

    expect(lounge?.listing).not.toHaveProperty("price");
    expect(lounge?.listing).not.toHaveProperty("minimumOrder");
    expect(lounge?.supplier).not.toHaveProperty("verifications");
    expect(lounge?.assessment?.designSimilarityIndex).toBeNull();
  });

  it("completes when a candidate has no supplier and no assessment", async () => {
    const discovery = { discoverCandidates: async () => discoveryResult(["mock-listing-006", "mock-listing-001"]) };
    const run = await new SourcingPipeline(createDeps({ discovery })).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
    });

    expect(rows(run)).toEqual([
      { rank: 1, listingId: "mock-listing-001", classification: "exact_visual_design", supplierId: "mock-supplier-001" },
      { rank: 2, listingId: "mock-listing-006", classification: undefined, supplierId: undefined },
    ]);
  });

  it("returns a valid empty result when discovery finds no candidates", async () => {
    const deps = createDeps();
    const verify = vi.spyOn(deps.visualVerification, "verify");
    const rank = vi.spyOn(deps.ranking, "rank");

    const run = await new SourcingPipeline(deps).run({ reference: MOCK_REFERENCE_IMAGES.bed });

    expect(run.reference.id).toBe("mock-ref-bed-001");
    expect(run.fingerprint.category).toBe("bed");
    expect(run.discovery.listings).toEqual([]);
    expect(run.discovery.suppliers).toEqual([]);
    expect(run.assessments).toEqual([]);
    expect(run.results).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(rank).toHaveBeenCalledWith({ listings: [], suppliers: [], assessments: [] });
  });
});

describe("SourcingPipeline — orchestration", () => {
  it("runs the stages in order and passes each stage's output to the next", async () => {
    const deps = createDeps();
    const analyze = vi.spyOn(deps.imageUnderstanding, "analyze");
    const discover = vi.spyOn(deps.discovery, "discoverCandidates");
    const verify = vi.spyOn(deps.visualVerification, "verify");
    const rank = vi.spyOn(deps.ranking, "rank");

    const run = await new SourcingPipeline(deps).run({
      reference: MOCK_REFERENCE_IMAGES.chair,
      discovery: { limit: 5, mode: "text" },
    });

    const order = [analyze, discover, verify, rank].map((s) => s.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(analyze).toHaveBeenCalledWith(MOCK_REFERENCE_IMAGES.chair);
    expect(discover).toHaveBeenCalledWith({
      reference: MOCK_REFERENCE_IMAGES.chair,
      fingerprint: run.fingerprint,
      mode: "text",
      limit: 5,
    });
    expect(verify).toHaveBeenCalledWith({
      reference: MOCK_REFERENCE_IMAGES.chair,
      fingerprint: run.fingerprint,
      listings: run.discovery.listings,
    });
    expect(rank).toHaveBeenCalledWith({
      listings: run.discovery.listings,
      suppliers: run.discovery.suppliers,
      assessments: run.assessments,
    });
  });

  it("produces identical results for repeated runs with a fixed clock", async () => {
    const pipeline = new SourcingPipeline(createDeps());
    const first = await pipeline.run({ reference: MOCK_REFERENCE_IMAGES.chair });
    const second = await pipeline.run({ reference: MOCK_REFERENCE_IMAGES.chair });

    expect(second).toEqual(first);
  });

  it("does not mutate the input reference or fixtures", async () => {
    const reference: ReferenceImage = structuredClone(MOCK_REFERENCE_IMAGES.chair);
    const before = structuredClone({ reference, MOCK_LISTINGS, MOCK_SUPPLIERS, MOCK_ASSESSMENTS });

    const run = await new SourcingPipeline(createDeps()).run({ reference });
    run.reference.id = "changed";
    run.results[0].listing.title = "changed";
    run.discovery.listings[0].title = "changed";

    expect({ reference, MOCK_LISTINGS, MOCK_SUPPLIERS, MOCK_ASSESSMENTS }).toEqual(before);
  });

  it("keeps provenance so synthetic output is identifiable", async () => {
    const run = await new SourcingPipeline(createDeps()).run({
      reference: MOCK_REFERENCE_IMAGES.table,
    });

    expect(run.fingerprint.source.kind).toBe("fixture");
    expect(run.discovery.provider.dataSource).toBe("mock");
    expect(run.results.every((r) => r.listing.provenance.dataSource === "mock")).toBe(true);
    expect(run.assessments.every((a) => a.metadata?.method === "fixture")).toBe(true);

    const summary = summarizeSourcingRun(run);
    expect(summary.containsSyntheticData).toBe(true);
    expect(summary.results.map((r) => r.designSimilarityIndex)).toEqual([81, 22]);
  });

  it("makes no network requests", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await new SourcingPipeline(createDeps()).run({ reference: MOCK_REFERENCE_IMAGES.chair });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SourcingPipeline — data integrity", () => {
  const withAssessments = (assessments: VisualMatchAssessment[]) =>
    new SourcingPipeline(
      createDeps({ visualVerification: { verify: async () => assessments } }),
    ).run({ reference: MOCK_REFERENCE_IMAGES.chair });

  it("rejects an assessment for a listing that was not discovered", async () => {
    const error = await expectStageError(
      withAssessments([chairAssessment({ listingId: "mock-listing-004" })]),
      "visual_verification",
    );
    expect(error.message).toMatch(/unknown listing "mock-listing-004"/);
  });

  it("rejects duplicate assessments for the same listing", async () => {
    await expectStageError(
      withAssessments([chairAssessment({}), chairAssessment({ id: "dup" })]),
      "visual_verification",
    );
  });

  it("rejects assessments for a different reference or fingerprint", async () => {
    await expectStageError(
      withAssessments([chairAssessment({ referenceImageId: "mock-ref-table-001" })]),
      "visual_verification",
    );
    await expectStageError(
      withAssessments([chairAssessment({ fingerprintId: "mock-fp-table-001" })]),
      "visual_verification",
    );
  });

  it("rejects out-of-range similarity values", async () => {
    await expectStageError(
      withAssessments([chairAssessment({ designSimilarityIndex: 140 })]),
      "visual_verification",
    );
  });

  it("rejects a fingerprint that is not associated with the reference", async () => {
    const imageUnderstanding = {
      analyze: async () => ({
        ...(await new MockImageUnderstandingService().analyze(MOCK_REFERENCE_IMAGES.table)),
      }),
    };
    await expectStageError(
      new SourcingPipeline(createDeps({ imageUnderstanding })).run({
        reference: MOCK_REFERENCE_IMAGES.chair,
      }),
      "image_understanding",
    );
  });

  it("rejects duplicate listings from discovery", async () => {
    const discovery = {
      discoverCandidates: async () => discoveryResult(["mock-listing-001", "mock-listing-001"]),
    };
    await expectStageError(
      new SourcingPipeline(createDeps({ discovery })).run({ reference: MOCK_REFERENCE_IMAGES.chair }),
      "candidate_discovery",
    );
  });

  it("rejects ranking output that drops a listing or mismatches a supplier", async () => {
    const real = new ProvisionalRankingService();
    const dropping = {
      rank: async (req: Parameters<typeof real.rank>[0]) => (await real.rank(req)).slice(1),
    };
    const swapping = {
      rank: async (req: Parameters<typeof real.rank>[0]) => {
        const results = await real.rank(req);
        [results[0].supplier, results[1].supplier] = [results[1].supplier, results[0].supplier];
        return results;
      },
    };

    for (const ranking of [dropping, swapping]) {
      await expectStageError(
        new SourcingPipeline(createDeps({ ranking })).run({ reference: MOCK_REFERENCE_IMAGES.chair }),
        "ranking",
      );
    }
  });
});

describe("SourcingPipeline — stage errors", () => {
  it("reports an unsupported reference as an image_understanding failure", async () => {
    const reference: ReferenceImage = {
      ...MOCK_REFERENCE_IMAGES.chair,
      id: "not-a-fixture",
    };
    const error = await expectStageError(
      new SourcingPipeline(createDeps()).run({ reference }),
      "image_understanding",
    );
    expect(error.cause).toBeInstanceOf(UnsupportedReferenceError);
  });

  const cause = new Error("synthetic failure");
  const failing = async () => {
    throw cause;
  };

  it.each<[PipelineStage, Partial<SourcingPipelineDependencies>]>([
    ["image_understanding", { imageUnderstanding: { analyze: failing } }],
    ["candidate_discovery", { discovery: { discoverCandidates: failing } }],
    ["visual_verification", { visualVerification: { verify: failing } }],
    ["ranking", { ranking: { rank: failing } }],
  ])("surfaces a %s failure with its stage and cause", async (stage, overrides) => {
    const error = await expectStageError(
      new SourcingPipeline(createDeps(overrides)).run({ reference: MOCK_REFERENCE_IMAGES.chair }),
      stage,
    );
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("synthetic failure");
  });

  it("surfaces invalid discovery parameters as a candidate_discovery failure", async () => {
    const error = await expectStageError(
      new SourcingPipeline(createDeps()).run({
        reference: MOCK_REFERENCE_IMAGES.chair,
        discovery: { limit: 0 },
      }),
      "candidate_discovery",
    );
    expect(error.cause).toBeInstanceOf(RangeError);
  });

  it("does not run later stages after a failure", async () => {
    const deps = createDeps({ discovery: { discoverCandidates: failing } });
    const verify = vi.spyOn(deps.visualVerification, "verify");
    const rank = vi.spyOn(deps.ranking, "rank");

    await expectStageError(
      new SourcingPipeline(deps).run({ reference: MOCK_REFERENCE_IMAGES.chair }),
      "candidate_discovery",
    );
    expect(verify).not.toHaveBeenCalled();
    expect(rank).not.toHaveBeenCalled();
  });
});
