import { describe, expect, it } from "vitest";
import type { FurnitureFingerprint } from "../domain";
import { evaluationDatasetSchema, type EvaluationDataset } from "./dataset";
import { evaluate, stats, type EvaluationInput, type Loaded } from "./engine";
import { renderJsonReport, renderMarkdownReport } from "./report";
import type { ReviewRecord } from "./review";
import type { RunRecord, RunResult } from "./run-record";

/* All data below is synthetic, built for unit tests. */

const BASELINE = { model: "gpt-6-luna", instructionsVersion: "2026-10-24.1", imageDetail: "high", reasoningEffort: "low", maxOutputTokens: 4096 };
const feature = (id: string, priority: "critical" | "supporting", distinctive = false) => ({ id, description: `Synthetic ${id}`, priority, aspect: "structure" as const, distinctive });
const src = { kind: "other" as const, description: "synthetic" };

function dataset(purpose: "benchmark" | "tooling_test" = "benchmark"): EvaluationDataset {
  return evaluationDatasetSchema.parse({
    schemaVersion: 1,
    datasetId: "unit",
    datasetVersion: "1",
    purpose,
    baseline: BASELINE,
    cases: [
      { id: "bed", group: "bed", source: src, conditions: ["clean_product_photo"], annotationStatus: "adjudicated",
        expected: { outcome: "furniture_identified", category: "bed", alsoAcceptableCategories: ["bed_frame"], features: [feature("headboard", "critical", true), feature("footboard", "critical"), feature("legs", "supporting")] } },
      { id: "chair", group: "chair", source: src, conditions: ["lifestyle_photo"], annotationStatus: "adjudicated",
        expected: { outcome: "furniture_identified", category: "chair", features: [feature("back", "critical", true)] } },
      { id: "landscape", group: "non_furniture", source: src, conditions: ["non_furniture"], annotationStatus: "adjudicated",
        expected: { outcome: "no_furniture", alsoAcceptableOutcomes: ["unreadable_image"] } },
      { id: "room", group: "ambiguous", source: src, conditions: ["multiple_objects", "ambiguous_target"], annotationStatus: "adjudicated",
        expected: { outcome: "ambiguous_target" } },
    ],
  });
}

const fingerprint = (caseId: string, category: string): FurnitureFingerprint => ({
  id: `fp-${caseId}`,
  referenceImageIds: [`ref-${caseId}`],
  category,
  structure: [{ attribute: "a", certainty: "observed", value: "x" }],
  appearance: [{ attribute: "b", certainty: "inferred", value: "y" }, { attribute: "c", certainty: "unknown" }],
  distinctiveFeatures: [],
  searchQueries: ["q one", "q two", "Q one"],
  source: { kind: "model", dataSource: "live", modelId: "gpt-6-luna" },
  createdAt: "2026-10-24T10:00:00.000Z",
});

const usage = (inputTokens: number, outputTokens: number, reasoningTokens?: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, reasoningTokens });

function run(caseId: string | null, result: RunResult, opts: Partial<{ usage: RunRecord["response"]["usage"]; durationMs: number | null; recordedAt: string; responseId: string | null; request: Partial<RunRecord["request"]>; sha: string; dataSource: "live" | "mock" }> = {}): Loaded<RunRecord> {
  return {
    file: `${caseId ?? "none"}${opts.recordedAt ? `-${opts.recordedAt.slice(0, 10)}` : ""}.json`,
    record: {
      recordType: "image_understanding_run",
      schemaVersion: 1,
      caseId,
      recordedAt: opts.recordedAt ?? "2026-10-24T10:00:00.000Z",
      dataSource: opts.dataSource ?? "live",
      image: { sha256: opts.sha ?? "0".repeat(64), mimeType: "image/png", bytes: 10 },
      referenceId: `ref-${caseId}`,
      request: { ...BASELINE, timeoutMs: 60000, ...opts.request },
      response: { responseId: opts.responseId === undefined ? `resp-${caseId}` : opts.responseId, responseModel: "gpt-6-luna", usage: opts.usage === undefined ? usage(1000, 200, 50) : opts.usage, durationMs: opts.durationMs === undefined ? 1000 : opts.durationMs },
      result,
    },
  };
}
const furniture = (caseId: string, category: string): RunResult => ({ kind: "furniture_identified", fingerprint: fingerprint(caseId, category) });
const rejected = (modelOutcome: "no_furniture" | "ambiguous_target" | "unreadable_image"): RunResult => ({ kind: "not_identified", modelOutcome, modelReason: "synthetic" });
const failed = (errorCategory: "rate_limit" | "timeout"): RunResult => ({ kind: "error", errorCategory, message: "synthetic", status: null, requestId: null });

function review(caseId: string, patch: Partial<ReviewRecord> = {}): Loaded<ReviewRecord> {
  return {
    file: `${caseId}.json`,
    record: {
      recordType: "image_understanding_review",
      schemaVersion: 1,
      caseId,
      responseId: `resp-${caseId}`,
      status: "complete",
      reviewer: "unit-reviewer",
      reviewedAt: "2026-10-25T00:00:00.000Z",
      objectSelection: "correct",
      features: [],
      unsupportedAssertions: [],
      uncertainty: { judgement: "appropriate" },
      searchQueries: { rating: 4, broadCategoryQueryPresent: true, distinctiveTermsIncluded: true, excessivelyNarrow: false, irrelevantOrFabricatedTerms: false, exploresAlternatives: null },
      failureTags: [],
      notes: "",
      ...patch,
    },
  };
}

const evalWith = (input: Partial<EvaluationInput>) =>
  evaluate({ dataset: dataset(), runs: [], reviews: [], loadIssues: [], generatedAt: "2026-10-25T00:00:00.000Z", runId: "eval-unit", ...input });

describe("automated metrics", () => {
  it("compares categories, accepting annotator alternatives", () => {
    const report = evalWith({ runs: [run("bed", furniture("bed", "bed_frame")), run("chair", furniture("chair", "stool"))] });
    expect(report.automated.category).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(report.notableFailures).toContainEqual({ caseId: "chair", kind: "category_mismatch", detail: "expected chair, got stool" });
  });

  it("counts correct rejections of non-furniture and ambiguous images as correct outcomes, not errors", () => {
    const report = evalWith({ runs: [run("landscape", rejected("unreadable_image")), run("room", rejected("ambiguous_target"))] });
    expect(report.automated.expectedOutcome).toMatchObject({ numerator: 2, denominator: 2 });
    expect(report.automated.modelResponded).toMatchObject({ numerator: 2, denominator: 2 });
    expect(Object.values(report.automated.runErrors).every((n) => n === 0)).toBe(true);
    expect(report.automated.category.denominator).toBe(0);
  });

  it("flags wrong rejections and false identifications", () => {
    const report = evalWith({ runs: [run("bed", rejected("no_furniture")), run("landscape", furniture("landscape", "chair"))] });
    expect(report.automated.expectedOutcome).toMatchObject({ numerator: 0, denominator: 2 });
    expect(report.notableFailures.filter((f) => f.kind === "outcome_mismatch").map((f) => f.caseId)).toEqual(["bed", "landscape"]);
    const row = report.automated.outcomeConfusion.find((r) => r.expected === "no_furniture");
    expect(row?.predicted.furniture_identified).toBe(1);
  });

  it("keeps API failures out of outcome accuracy and counts them by type", () => {
    const report = evalWith({ runs: [run("bed", failed("rate_limit")), run("chair", failed("timeout")), run("room", rejected("ambiguous_target"))] });
    expect(report.automated.runErrors).toMatchObject({ rate_limit: 1, timeout: 1 });
    expect(report.automated.expectedOutcome).toMatchObject({ numerator: 1, denominator: 1 });
    expect(report.automated.modelResponded).toMatchObject({ numerator: 1, denominator: 3 });
  });

  it("reports missing predictions in the denominator of coverage", () => {
    const report = evalWith({ runs: [run("bed", furniture("bed", "bed"))] });
    expect(report.automated.casesWithRun).toMatchObject({ numerator: 1, denominator: 4, of: "declared cases" });
    expect(report.missing.casesWithoutRun).toEqual(["chair", "landscape", "room"]);
  });

  it("computes token statistics from API totals without re-adding reasoning tokens", () => {
    const report = evalWith({
      runs: [
        run("bed", furniture("bed", "bed"), { usage: usage(1000, 300, 100) }),
        run("chair", furniture("chair", "chair"), { usage: usage(2000, 100) }),
        run("room", rejected("ambiguous_target"), { usage: null, durationMs: null }),
      ],
    });
    const u = report.automated.usage;
    expect(u.runsWithUsage).toBe(2);
    expect(u.runsWithoutUsage).toBe(1);
    expect(u.totalTokens).toEqual({ count: 2, sum: 3400, mean: 1700, median: 1700 });
    expect(u.reasoningTokens).toEqual({ count: 1, sum: 100, mean: 100, median: 100 });
    expect(u.durationMs.count).toBe(2);
    expect(u.inconsistentTotals).toBe(0);
  });

  it("reports completeness without judging correctness", () => {
    const c = evalWith({ runs: [run("bed", furniture("bed", "bed"))] }).automated.completeness;
    expect(c.certaintyTotals).toEqual({ observed: 1, inferred: 1, unknown: 1 });
    expect(c.duplicateQueries).toBe(1);
  });

  it("never divides by zero", () => {
    const report = evalWith({});
    expect(report.automated.expectedOutcome).toMatchObject({ numerator: 0, denominator: 0, rate: null });
    expect(report.automated.usage.totalTokens).toEqual({ count: 0, sum: 0, mean: null, median: null });
    expect(report.human.criticalFeatures.captured.rate).toBeNull();
    expect(report.scope.join(" ")).toMatch(/No usable predictions/);
  });

  it("excludes off-baseline, mismatched-image and unassigned runs, and uses the latest run per case", () => {
    const ds = dataset();
    ds.cases[1].imageSha256 = "a".repeat(64);
    const report = evalWith({
      dataset: ds,
      runs: [
        run("bed", furniture("bed", "bed"), { request: { instructionsVersion: "2026-11-01.1" } }),
        run("chair", furniture("chair", "chair"), { sha: "b".repeat(64) }),
        run(null, furniture("x", "bed")),
        run("room", rejected("no_furniture"), { recordedAt: "2026-10-01T00:00:00.000Z" }),
        run("room", rejected("ambiguous_target"), { recordedAt: "2026-10-20T00:00:00.000Z" }),
      ],
    });
    const problems = report.missing.associationIssues.map((i) => `${i.caseId}:${i.problem}`);
    expect(problems).toEqual(expect.arrayContaining(["bed:off_baseline", "chair:image_mismatch", "null:no_case_id", "room:superseded"]));
    expect(report.run.usablePredictions).toBe(1);
    expect(report.automated.expectedOutcome).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("is deterministic", () => {
    const input = { runs: [run("bed", furniture("bed", "bed")), run("room", rejected("ambiguous_target"))], reviews: [review("bed")] };
    expect(evalWith(input)).toEqual(evalWith(input));
    expect(renderMarkdownReport(evalWith(input))).toBe(renderMarkdownReport(evalWith(input)));
  });

  it("stats computes medians for even and odd counts", () => {
    expect(stats([3, 1, 2]).median).toBe(2);
    expect(stats([4, 1, 3, 2]).median).toBe(2.5);
  });
});

describe("human-reviewed metrics", () => {
  const runs = [run("bed", furniture("bed", "bed")), run("chair", furniture("chair", "chair"))];

  it("aggregates feature coverage and excludes not_reviewed features from denominators", () => {
    const report = evalWith({
      runs,
      reviews: [
        review("bed", { features: [
          { featureId: "headboard", judgement: "captured" },
          { featureId: "footboard", judgement: "not_reviewed" },
          { featureId: "legs", judgement: "partial" },
        ] }),
        review("chair", { features: [{ featureId: "back", judgement: "contradicted" }] }),
      ],
    });
    const critical = report.human.criticalFeatures;
    expect(critical.declaredInReviewedCases).toBe(3);
    expect(critical.judged).toBe(2);
    expect(critical.captured).toMatchObject({ numerator: 1, denominator: 2 });
    expect(critical.missedOrContradicted).toMatchObject({ numerator: 1, denominator: 2 });
    expect(report.human.supportingFeatures.capturedOrPartial).toMatchObject({ numerator: 1, denominator: 1 });
    expect(report.human.distinctiveFeatures).toMatchObject({ judged: 2, missedOrContradicted: { numerator: 1, denominator: 2 } });
    expect(report.notableFailures).toContainEqual(expect.objectContaining({ caseId: "chair", kind: "contradicted_feature" }));
  });

  it("only counts complete reviews and reports stale, duplicate and orphan reviews", () => {
    const report = evalWith({
      runs,
      reviews: [
        review("bed", { status: "in_progress", reviewer: null, reviewedAt: null }),
        review("chair", { responseId: "resp-older" }),
        review("room"),
      ],
    });
    expect(report.human.reviewStatus).toMatchObject({ complete: 0, inProgress: 1 });
    expect(report.human.objectSelection.correct.denominator).toBe(0);
    expect(report.missing.associationIssues.map((i) => `${i.caseId}:${i.problem}`)).toEqual(
      expect.arrayContaining(["chair:stale_review", "room:review_without_prediction"]),
    );
    expect(report.scope.join(" ")).toMatch(/No complete human reviews/);

    const duplicate = evalWith({ runs, reviews: [review("bed"), { ...review("bed"), file: "bed-2.json" }] });
    expect(duplicate.human.reviewStatus.complete).toBe(0);
    expect(duplicate.missing.associationIssues.filter((i) => i.problem === "duplicate_review")).toHaveLength(2);
  });

  it("aggregates object selection, uncertainty, assertions, queries and failure tags", () => {
    const report = evalWith({
      runs,
      reviews: [
        review("bed", {
          unsupportedAssertions: [{ claim: "solid oak", type: "overconfident_material_or_dimension", explanation: "not verifiable" }],
          failureTags: ["overconfident_material"],
        }),
        review("chair", { objectSelection: "wrong_object", uncertainty: { judgement: "overconfident" }, searchQueries: { rating: 2, broadCategoryQueryPresent: false, distinctiveTermsIncluded: null, excessivelyNarrow: true, irrelevantOrFabricatedTerms: false, exploresAlternatives: false }, failureTags: ["wrong_object", "overconfident_material"] }),
      ],
    });
    const h = report.human;
    expect(h.objectSelection.correct).toMatchObject({ numerator: 1, denominator: 2 });
    expect(h.uncertainty.appropriate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(h.unsupportedAssertions).toMatchObject({ total: 1, reviewsWithAny: { numerator: 1, denominator: 2 } });
    expect(h.searchQueries.rating).toMatchObject({ count: 2, mean: 3 });
    expect(h.searchQueries.flags.distinctiveTermsIncluded).toEqual({ yes: 1, no: 0, unanswered: 1 });
    expect(h.failureTags[0]).toEqual({ tag: "overconfident_material", count: 2 });
    expect(report.notableFailures).toContainEqual(expect.objectContaining({ caseId: "chair", kind: "wrong_object" }));
  });

  it("reports unknown feature ids in reviews instead of counting them", () => {
    const report = evalWith({ runs, reviews: [review("bed", { features: [{ featureId: "armrest", judgement: "captured" }] })] });
    expect(report.human.criticalFeatures.judged).toBe(0);
    expect(report.missing.associationIssues).toContainEqual(expect.objectContaining({ caseId: "bed", problem: "unknown_feature_id" }));
  });
});

describe("reports", () => {
  it("labels synthetic data and tooling-test datasets", () => {
    const mockRun = run("bed", { kind: "furniture_identified", fingerprint: { ...fingerprint("bed", "bed"), source: { kind: "fixture", dataSource: "mock" } } }, { dataSource: "mock" });
    const fromMock = evalWith({ runs: [mockRun] });
    expect(fromMock.run.synthetic).toBe(true);
    expect(renderMarkdownReport(fromMock)).toMatch(/^# Image understanding evaluation — SYNTHETIC/);

    const toolingTest = evalWith({ dataset: dataset("tooling_test") });
    expect(toolingTest.scope[0]).toMatch(/^SYNTHETIC/);

    const live = evalWith({ runs: [run("bed", furniture("bed", "bed"))] });
    expect(live.run.synthetic).toBe(false);
    expect(live.scope.join(" ")).toMatch(/limited to 1 photograph/);
  });

  it("shows denominators, missing data and no combined score", () => {
    const report = evalWith({ runs: [run("bed", furniture("bed", "bed"))] });
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("| Category | 1 / 1 (100.0%) | furniture cases whose run identified furniture |");
    expect(markdown).toContain("- Cases without a run in use: chair, landscape, room");
    expect(markdown).toContain("_No complete reviews yet; no human-reviewed metrics are reported._");
    for (const section of ["## 1. Run summary", "## 4. Automated metrics", "## 7. Results by image condition", "## 10. Recommended areas"]) {
      expect(markdown).toContain(section);
    }
    const json = renderJsonReport(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toMatch(/"overall(Score|Accuracy)"/i);
  });
});
