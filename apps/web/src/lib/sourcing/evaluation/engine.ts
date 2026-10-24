import type { FurnitureFingerprint } from "../domain";
import {
  acceptableOutcomes,
  type EvaluationCase,
  type EvaluationDataset,
  type EvaluationOutcome,
} from "./dataset";
import { FEATURE_JUDGEMENTS, UNSUPPORTED_ASSERTION_TYPES, type ReviewRecord } from "./review";
import { RUN_ERROR_CATEGORIES, type RunErrorCategory, type RunRecord } from "./run-record";

/* ---------- Inputs ---------- */

export interface Loaded<T> {
  /** File name (no directory), for reporting. */
  file: string;
  record: T;
}

export interface LoadIssue {
  file: string;
  problem: "malformed_json" | "invalid_record" | "unreadable";
  detail: string;
}

export interface ImageCheck {
  caseId: string;
  status: "matches" | "mismatch" | "missing_file" | "no_expected_hash";
}

export interface EvaluationInput {
  dataset: EvaluationDataset;
  runs: Loaded<RunRecord>[];
  reviews: Loaded<ReviewRecord>[];
  loadIssues: LoadIssue[];
  imageChecks?: ImageCheck[];
  generatedAt: string;
  runId: string;
}

/* ---------- Output building blocks ---------- */

export interface Ratio {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0. */
  rate: number | null;
  /** What was counted in the denominator. */
  of: string;
}

export interface Stats {
  count: number;
  sum: number;
  mean: number | null;
  median: number | null;
}

const ratio = (numerator: number, denominator: number, of: string): Ratio => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
  of,
});

export function stats(values: number[]): Stats {
  if (values.length === 0) return { count: 0, sum: 0, mean: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { count: sorted.length, sum, mean: sum / sorted.length, median };
}

const countBy = <K extends string>(keys: readonly K[], values: K[]) =>
  Object.fromEntries(keys.map((k) => [k, values.filter((v) => v === k).length])) as Record<K, number>;

/* ---------- Association ---------- */

type PredictedOutcome = EvaluationOutcome | "error";

interface CaseEvaluation {
  case: EvaluationCase;
  run?: RunRecord;
  runFile?: string;
  review?: ReviewRecord;
  predicted?: PredictedOutcome;
  outcomeCorrect?: boolean;
  categoryCorrect?: boolean;
}

export interface AssociationIssue {
  file: string;
  caseId: string | null;
  problem:
    | "no_case_id"
    | "unknown_case"
    | "off_baseline"
    | "superseded"
    | "image_mismatch"
    | "review_without_prediction"
    | "stale_review"
    | "duplicate_review"
    | "unknown_feature_id";
  detail: string;
}

function onBaseline(run: RunRecord, dataset: EvaluationDataset): string | null {
  const b = dataset.baseline;
  const r = run.request;
  const diffs = [
    r.model !== b.model && `model ${r.model}`,
    r.instructionsVersion !== b.instructionsVersion && `instructions ${r.instructionsVersion}`,
    r.imageDetail !== b.imageDetail && `detail ${r.imageDetail}`,
    r.reasoningEffort !== b.reasoningEffort && `reasoning ${r.reasoningEffort}`,
    r.maxOutputTokens !== b.maxOutputTokens && `maxOutputTokens ${r.maxOutputTokens}`,
  ].filter(Boolean);
  return diffs.length ? diffs.join(", ") : null;
}

function predictedOutcome(run: RunRecord): PredictedOutcome {
  if (run.result.kind === "furniture_identified") return "furniture_identified";
  if (run.result.kind === "not_identified") return run.result.modelOutcome;
  return "error";
}

function associate(input: EvaluationInput) {
  const { dataset } = input;
  const issues: AssociationIssue[] = [];
  const caseById = new Map(dataset.cases.map((c) => [c.id, c]));
  const runsByCase = new Map<string, Loaded<RunRecord>[]>();

  for (const loaded of input.runs) {
    const { record, file } = loaded;
    if (record.caseId === null) {
      issues.push({ file, caseId: null, problem: "no_case_id", detail: "Run record has no caseId" });
      continue;
    }
    const c = caseById.get(record.caseId);
    if (!c) {
      issues.push({ file, caseId: record.caseId, problem: "unknown_case", detail: "caseId is not in the dataset" });
      continue;
    }
    const off = onBaseline(record, dataset);
    if (off) {
      issues.push({ file, caseId: c.id, problem: "off_baseline", detail: `Differs from baseline: ${off}` });
      continue;
    }
    if (c.imageSha256 && c.imageSha256 !== record.image.sha256) {
      issues.push({ file, caseId: c.id, problem: "image_mismatch", detail: "Image hash differs from the dataset's imageSha256" });
      continue;
    }
    runsByCase.set(c.id, [...(runsByCase.get(c.id) ?? []), loaded]);
  }

  const evaluations: CaseEvaluation[] = dataset.cases.map((c) => {
    const candidates = [...(runsByCase.get(c.id) ?? [])].sort(
      (a, b) => b.record.recordedAt.localeCompare(a.record.recordedAt) || a.file.localeCompare(b.file),
    );
    const [chosen, ...older] = candidates;
    for (const o of older) {
      issues.push({ file: o.file, caseId: c.id, problem: "superseded", detail: `A later run (${chosen.file}) is used` });
    }
    if (!chosen) return { case: c };

    const run = chosen.record;
    const predicted = predictedOutcome(run);
    const evaluation: CaseEvaluation = { case: c, run, runFile: chosen.file, predicted };
    if (predicted !== "error") evaluation.outcomeCorrect = acceptableOutcomes(c).includes(predicted);
    if (c.expected.outcome === "furniture_identified" && run.result.kind === "furniture_identified") {
      const accepted = [c.expected.category, ...c.expected.alsoAcceptableCategories];
      evaluation.categoryCorrect = accepted.includes(run.result.fingerprint.category);
    }
    return evaluation;
  });

  const evalById = new Map(evaluations.map((e) => [e.case.id, e]));
  const reviewsByCase = new Map<string, Loaded<ReviewRecord>[]>();
  for (const loaded of input.reviews) {
    const { record, file } = loaded;
    const e = evalById.get(record.caseId);
    if (!e) {
      issues.push({ file, caseId: record.caseId, problem: "unknown_case", detail: "caseId is not in the dataset" });
      continue;
    }
    if (!e.run) {
      issues.push({ file, caseId: record.caseId, problem: "review_without_prediction", detail: "No usable run for this case" });
      continue;
    }
    if (record.responseId !== null && e.run.response.responseId !== null && record.responseId !== e.run.response.responseId) {
      issues.push({ file, caseId: record.caseId, problem: "stale_review", detail: "Review refers to a different response than the run in use" });
      continue;
    }
    reviewsByCase.set(record.caseId, [...(reviewsByCase.get(record.caseId) ?? []), loaded]);
  }

  for (const e of evaluations) {
    const reviews = reviewsByCase.get(e.case.id) ?? [];
    if (reviews.length > 1) {
      for (const r of reviews) {
        issues.push({ file: r.file, caseId: e.case.id, problem: "duplicate_review", detail: "Several reviews for one case; none used" });
      }
      continue;
    }
    const review = reviews[0]?.record;
    if (!review) continue;
    e.review = review;
    if (e.case.expected.outcome === "furniture_identified") {
      const known = new Set(e.case.expected.features.map((f) => f.id));
      for (const f of review.features) {
        if (!known.has(f.featureId)) {
          issues.push({ file: reviews[0].file, caseId: e.case.id, problem: "unknown_feature_id", detail: `"${f.featureId}" is not an expected feature; ignored` });
        }
      }
    }
  }

  return { evaluations, issues };
}

/* ---------- Metrics ---------- */

function completeness(fingerprints: FurnitureFingerprint[]) {
  const features = fingerprints.flatMap((fp) => [...fp.structure, ...fp.appearance, ...fp.distinctiveFeatures]);
  const queryIssues = fingerprints.map((fp) => {
    const normalized = fp.searchQueries.map((q) => q.trim().toLowerCase());
    return {
      empty: normalized.filter((q) => !q).length,
      duplicates: normalized.length - new Set(normalized).size,
    };
  });
  return {
    of: "furniture_identified predictions",
    predictions: fingerprints.length,
    structureFeatures: stats(fingerprints.map((fp) => fp.structure.length)),
    appearanceFeatures: stats(fingerprints.map((fp) => fp.appearance.length)),
    distinctiveFeatures: stats(fingerprints.map((fp) => fp.distinctiveFeatures.length)),
    certaintyTotals: countBy(["observed", "inferred", "unknown"] as const, features.map((f) => f.certainty)),
    searchQueries: stats(fingerprints.map((fp) => fp.searchQueries.length)),
    predictionsWithoutQueries: fingerprints.filter((fp) => fp.searchQueries.length === 0).length,
    emptyQueries: queryIssues.reduce((a, q) => a + q.empty, 0),
    duplicateQueries: queryIssues.reduce((a, q) => a + q.duplicates, 0),
  };
}

function usage(runs: RunRecord[]) {
  const withUsage = runs.flatMap((r) => (r.response.usage ? [r.response.usage] : []));
  const durations = runs.flatMap((r) => (r.response.durationMs === null ? [] : [r.response.durationMs]));
  return {
    of: "runs in use that reported token usage (any result kind)",
    runsWithUsage: withUsage.length,
    runsWithoutUsage: runs.length - withUsage.length,
    inputTokens: stats(withUsage.map((u) => u.inputTokens)),
    // Reasoning tokens are part of outputTokens; totals are taken from the API, not re-added.
    outputTokens: stats(withUsage.map((u) => u.outputTokens)),
    totalTokens: stats(withUsage.map((u) => u.totalTokens)),
    reasoningTokens: stats(withUsage.flatMap((u) => (u.reasoningTokens === undefined ? [] : [u.reasoningTokens]))),
    inconsistentTotals: withUsage.filter((u) => u.inputTokens + u.outputTokens !== u.totalTokens).length,
    durationMs: stats(durations),
  };
}

const JUDGED = ["captured", "partial", "missed", "contradicted"] as const;

function featureCoverage(reviewed: CaseEvaluation[], filter: (f: { priority: string; distinctive: boolean }) => boolean, label: string) {
  let declared = 0;
  const judgements: (typeof FEATURE_JUDGEMENTS)[number][] = [];
  for (const e of reviewed) {
    if (e.case.expected.outcome !== "furniture_identified" || !e.review) continue;
    const byId = new Map(e.review.features.map((f) => [f.featureId, f.judgement]));
    for (const feature of e.case.expected.features.filter(filter)) {
      declared += 1;
      judgements.push(byId.get(feature.id) ?? "not_reviewed");
    }
  }
  const counts = countBy(FEATURE_JUDGEMENTS, judgements);
  const judged = JUDGED.reduce((a, k) => a + counts[k], 0);
  const of = `${label} judged in complete reviews (excludes not_reviewed)`;
  return {
    declaredInReviewedCases: declared,
    judged,
    counts,
    captured: ratio(counts.captured, judged, of),
    capturedOrPartial: ratio(counts.captured + counts.partial, judged, of),
    missedOrContradicted: ratio(counts.missed + counts.contradicted, judged, of),
  };
}

function humanMetrics(evaluations: CaseEvaluation[]) {
  const withRun = evaluations.filter((e) => e.run);
  const complete = withRun.filter((e) => e.review?.status === "complete");
  const inProgress = withRun.filter((e) => e.review?.status === "in_progress");
  const reviews = complete.map((e) => e.review as ReviewRecord);

  const selections = reviews.map((r) => r.objectSelection);
  const selectionJudged = selections.filter((s) => s === "correct" || s === "wrong_object" || s === "genuinely_ambiguous");
  const uncertainty = reviews.map((r) => r.uncertainty.judgement);
  const ratings = reviews.flatMap((r) => (r.searchQueries.rating === null ? [] : [r.searchQueries.rating]));
  const flagNames = ["broadCategoryQueryPresent", "distinctiveTermsIncluded", "excessivelyNarrow", "irrelevantOrFabricatedTerms", "exploresAlternatives"] as const;
  const assertions = reviews.flatMap((r) => r.unsupportedAssertions);

  return {
    reviewStatus: {
      casesWithRun: withRun.length,
      complete: complete.length,
      inProgress: inProgress.length,
      notStarted: withRun.length - complete.length - inProgress.length,
      reviewers: [...new Set(reviews.flatMap((r) => (r.reviewer ? [r.reviewer] : [])))].sort(),
    },
    objectSelection: {
      correct: ratio(selectionJudged.filter((s) => s === "correct").length, selectionJudged.length, "complete reviews with an object-selection judgement"),
      counts: countBy(["correct", "wrong_object", "genuinely_ambiguous", "not_applicable", "not_reviewed"] as const, selections),
    },
    criticalFeatures: featureCoverage(complete, (f) => f.priority === "critical", "critical features"),
    supportingFeatures: featureCoverage(complete, (f) => f.priority === "supporting", "supporting features"),
    distinctiveFeatures: featureCoverage(complete, (f) => f.distinctive, "distinctive features"),
    unsupportedAssertions: {
      total: assertions.length,
      byType: countBy(UNSUPPORTED_ASSERTION_TYPES, assertions.map((a) => a.type)),
      reviewsWithAny: ratio(reviews.filter((r) => r.unsupportedAssertions.length > 0).length, reviews.length, "complete reviews"),
    },
    uncertainty: {
      appropriate: ratio(
        uncertainty.filter((u) => u === "appropriate").length,
        uncertainty.filter((u) => u === "appropriate" || u === "overconfident" || u === "insufficiently_informative").length,
        "complete reviews with an uncertainty judgement",
      ),
      counts: countBy(["appropriate", "overconfident", "insufficiently_informative", "not_applicable", "not_reviewed"] as const, uncertainty),
    },
    searchQueries: {
      note: "Preliminary human ratings; not a measure of marketplace retrieval.",
      rating: stats(ratings),
      ratingDistribution: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, ratings.filter((r) => r === n).length])),
      flags: Object.fromEntries(
        flagNames.map((name) => {
          const values = reviews.map((r) => r.searchQueries[name]);
          return [name, { yes: values.filter((v) => v === true).length, no: values.filter((v) => v === false).length, unanswered: values.filter((v) => v === null).length }];
        }),
      ) as Record<(typeof flagNames)[number], { yes: number; no: number; unanswered: number }>,
    },
    failureTags: Object.entries(
      reviews.flatMap((r) => r.failureTags).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {}),
    )
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count })),
  };
}

function breakdown(evaluations: CaseEvaluation[], keyOf: (c: EvaluationCase) => string[]) {
  const keys = [...new Set(evaluations.flatMap((e) => keyOf(e.case)))].sort();
  return keys.map((key) => {
    const group = evaluations.filter((e) => keyOf(e.case).includes(key));
    const determined = group.filter((e) => e.outcomeCorrect !== undefined);
    const categorized = group.filter((e) => e.categoryCorrect !== undefined);
    const reviewed = group.filter((e) => e.review?.status === "complete");
    const critical = featureCoverage(reviewed, (f) => f.priority === "critical", "critical features");
    return {
      key,
      cases: group.length,
      withRun: group.filter((e) => e.run).length,
      errors: group.filter((e) => e.predicted === "error").length,
      outcomeCorrect: ratio(determined.filter((e) => e.outcomeCorrect).length, determined.length, "runs with a model outcome"),
      categoryCorrect: ratio(categorized.filter((e) => e.categoryCorrect).length, categorized.length, "furniture runs that identified furniture"),
      completeReviews: reviewed.length,
      criticalCaptured: critical.captured,
    };
  });
}

export interface NotableFailure {
  caseId: string;
  kind:
    | "run_error"
    | "outcome_mismatch"
    | "category_mismatch"
    | "contradicted_feature"
    | "missed_critical_feature"
    | "unsupported_assertion"
    | "wrong_object";
  detail: string;
}

function notableFailures(evaluations: CaseEvaluation[]): NotableFailure[] {
  const out: NotableFailure[] = [];
  for (const e of evaluations) {
    const id = e.case.id;
    const run = e.run;
    if (!run) continue;
    if (run.result.kind === "error") out.push({ caseId: id, kind: "run_error", detail: `${run.result.errorCategory}: ${run.result.message}` });
    if (e.outcomeCorrect === false) {
      out.push({ caseId: id, kind: "outcome_mismatch", detail: `expected ${acceptableOutcomes(e.case).join(" or ")}, model reported ${e.predicted}` });
    }
    if (e.categoryCorrect === false && run.result.kind === "furniture_identified" && e.case.expected.outcome === "furniture_identified") {
      out.push({ caseId: id, kind: "category_mismatch", detail: `expected ${e.case.expected.category}, got ${run.result.fingerprint.category}` });
    }
    const review = e.review?.status === "complete" ? e.review : undefined;
    if (!review) continue;
    if (review.objectSelection === "wrong_object") out.push({ caseId: id, kind: "wrong_object", detail: "Reviewer: wrong object selected" });
    if (e.case.expected.outcome === "furniture_identified") {
      const features = new Map(e.case.expected.features.map((f) => [f.id, f]));
      for (const f of review.features) {
        const expected = features.get(f.featureId);
        if (!expected) continue;
        if (f.judgement === "contradicted") out.push({ caseId: id, kind: "contradicted_feature", detail: `${expected.description}${f.note ? ` — ${f.note}` : ""}` });
        if (f.judgement === "missed" && expected.priority === "critical") out.push({ caseId: id, kind: "missed_critical_feature", detail: expected.description });
      }
    }
    for (const a of review.unsupportedAssertions) {
      out.push({ caseId: id, kind: "unsupported_assertion", detail: `${a.type}: "${a.claim}" — ${a.explanation}` });
    }
  }
  return out;
}

const PREDICTED_OUTCOMES = ["furniture_identified", "no_furniture", "ambiguous_target", "unreadable_image", "error"] as const;

export function evaluate(input: EvaluationInput) {
  const { dataset } = input;
  const { evaluations, issues } = associate(input);
  const withRun = evaluations.filter((e) => e.run);
  const runs = withRun.map((e) => e.run as RunRecord);
  const determined = withRun.filter((e) => e.outcomeCorrect !== undefined);
  const categorized = withRun.filter((e) => e.categoryCorrect !== undefined);
  const fingerprints = runs.flatMap((r) => (r.result.kind === "furniture_identified" ? [r.result.fingerprint] : []));
  const dataSources = countBy(["live", "mock"] as const, runs.map((r) => r.dataSource));
  const synthetic = dataset.purpose === "tooling_test" || dataSources.mock > 0;

  const expectedOutcomes = [...new Set(dataset.cases.map((c) => c.expected.outcome))].sort();
  const confusion = expectedOutcomes.map((expected) => ({
    expected,
    predicted: countBy(PREDICTED_OUTCOMES, withRun.filter((e) => e.case.expected.outcome === expected).map((e) => e.predicted as PredictedOutcome)),
  }));

  const human = humanMetrics(evaluations);
  const failures = notableFailures(evaluations);
  const missing = {
    casesWithoutRun: evaluations.filter((e) => !e.run).map((e) => e.case.id),
    casesWithoutCompleteReview: withRun.filter((e) => e.review?.status !== "complete").map((e) => e.case.id),
    associationIssues: issues,
    loadIssues: input.loadIssues,
    imageChecks: (input.imageChecks ?? []).filter((c) => c.status !== "matches"),
  };

  const groupCounts = Object.fromEntries(
    [...new Set(dataset.cases.map((c) => c.group))].sort().map((g) => [g, dataset.cases.filter((c) => c.group === g).length]),
  );

  return {
    reportType: "image_understanding_evaluation" as const,
    schemaVersion: 1 as const,
    run: {
      runId: input.runId,
      generatedAt: input.generatedAt,
      datasetId: dataset.datasetId,
      datasetVersion: dataset.datasetVersion,
      datasetPurpose: dataset.purpose,
      baseline: dataset.baseline,
      observedModels: [...new Set(runs.map((r) => r.response.responseModel ?? r.request.model))].sort(),
      observedInstructionVersions: [...new Set(runs.map((r) => r.request.instructionsVersion))].sort(),
      dataSources,
      synthetic,
      usablePredictions: runs.length,
      reviewers: human.reviewStatus.reviewers,
    },
    scope: scopeStatements(synthetic, dataset, runs.length, human.reviewStatus.complete),
    composition: {
      declaredCases: dataset.cases.length,
      byGroup: groupCounts,
      plannedComposition: dataset.plannedComposition ?? null,
      plannedTotal: dataset.plannedComposition ? Object.values(dataset.plannedComposition).reduce((a, b) => a + b, 0) : null,
      annotationStatus: countBy(["draft", "provisional", "adjudicated"] as const, dataset.cases.map((c) => c.annotationStatus)),
    },
    automated: {
      casesWithRun: ratio(withRun.length, dataset.cases.length, "declared cases"),
      modelResponded: ratio(withRun.filter((e) => e.predicted !== "error").length, withRun.length, "cases with a run in use"),
      runErrors: countBy(RUN_ERROR_CATEGORIES, runs.flatMap((r) => (r.result.kind === "error" ? [r.result.errorCategory as RunErrorCategory] : []))),
      expectedOutcome: ratio(determined.filter((e) => e.outcomeCorrect).length, determined.length, "cases whose run returned a model outcome (errors excluded)"),
      outcomeConfusion: confusion,
      category: ratio(categorized.filter((e) => e.categoryCorrect).length, categorized.length, "furniture cases whose run identified furniture"),
      subtypes: withRun.flatMap((e) =>
        e.case.expected.outcome === "furniture_identified" && e.run?.result.kind === "furniture_identified"
          ? [{ caseId: e.case.id, predicted: e.run.result.fingerprint.subtype ?? null, acceptable: e.case.expected.acceptableSubtypes }]
          : [],
      ),
      completeness: completeness(fingerprints),
      usage: usage(runs),
    },
    human,
    byGroup: breakdown(evaluations, (c) => [c.group]),
    byCondition: breakdown(evaluations, (c) => c.conditions),
    notableFailures: failures,
    missing,
    recommendations: recommendations(evaluations, failures, missing, synthetic),
  };
}

export type EvaluationReport = ReturnType<typeof evaluate>;

function scopeStatements(synthetic: boolean, dataset: EvaluationDataset, usable: number, reviewed: number): string[] {
  const out: string[] = [];
  if (synthetic) {
    out.push(
      "SYNTHETIC: this report uses synthetic fixtures or a tooling-test dataset. It shows the evaluation tooling works; it does not measure real model quality.",
    );
  }
  if (usable === 0) out.push("No usable predictions: no metric reflects model behaviour.");
  else if (usable < 5) out.push(`Conclusions are limited to ${usable} photograph(s); do not generalise to overall model accuracy.`);
  if (reviewed === 0) out.push("No complete human reviews: human-reviewed metrics are empty.");
  const provisional = dataset.cases.filter((c) => c.annotationStatus !== "adjudicated").length;
  if (provisional > 0) out.push(`${provisional} of ${dataset.cases.length} case annotation(s) are draft or provisional, not adjudicated.`);
  out.push("There is no single overall score: identification, structure, uncertainty and query quality are reported separately.");
  return out;
}

function recommendations(
  evaluations: CaseEvaluation[],
  failures: NotableFailure[],
  missing: { casesWithoutRun: string[]; casesWithoutCompleteReview: string[]; associationIssues: AssociationIssue[]; loadIssues: LoadIssue[] },
  synthetic: boolean,
): string[] {
  const out: string[] = [];
  if (synthetic) out.push("Run the real dataset with human-controlled live runs before drawing conclusions.");
  if (missing.casesWithoutRun.length) out.push(`Capture runs for ${missing.casesWithoutRun.length} case(s) without a prediction.`);
  if (missing.casesWithoutCompleteReview.length) out.push(`Complete human reviews for ${missing.casesWithoutCompleteReview.length} case(s).`);
  if (missing.loadIssues.length || missing.associationIssues.length) out.push("Resolve the file and association issues listed under Missing evaluations.");
  const byKind = (k: NotableFailure["kind"]) => [...new Set(failures.filter((f) => f.kind === k).map((f) => f.caseId))];
  const errorCases = byKind("run_error");
  if (errorCases.length) out.push(`Investigate run errors in: ${errorCases.join(", ")}.`);
  const outcome = byKind("outcome_mismatch");
  if (outcome.length) out.push(`Inspect outcome mismatches (wrong rejection or identification) in: ${outcome.join(", ")}.`);
  const category = byKind("category_mismatch");
  if (category.length) out.push(`Inspect category mismatches in: ${category.join(", ")}.`);
  const features = [...new Set([...byKind("missed_critical_feature"), ...byKind("contradicted_feature")])];
  if (features.length) out.push(`Review missed or contradicted critical features in: ${features.join(", ")}.`);
  const unsupported = byKind("unsupported_assertion");
  if (unsupported.length) out.push(`Check over-specific or unsupported claims in: ${unsupported.join(", ")}.`);
  const conditions = [...new Set(evaluations.filter((e) => failures.some((f) => f.caseId === e.case.id)).flatMap((e) => e.case.conditions))].sort();
  if (conditions.length) out.push(`Failures involve these image conditions: ${conditions.join(", ")}.`);
  if (!out.length) out.push("No issues detected in the available data; extend coverage before relying on this result.");
  return out;
}
