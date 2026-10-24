import type { EvaluationReport, Ratio, Stats } from "./engine";

const pct = (r: Ratio) => `${r.numerator} / ${r.denominator} (${r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}%`})`;
const ratioCell = (r: Ratio) => `${pct(r)}`;
const num = (n: number | null, digits = 1) => (n === null ? "n/a" : Number.isInteger(n) ? String(n) : n.toFixed(digits));
const statsCell = (s: Stats) => (s.count === 0 ? "n/a (0 runs)" : `mean ${num(s.mean)}, median ${num(s.median)}, total ${num(s.sum, 0)} (n=${s.count})`);

function table(headers: string[], rows: (string | number)[][]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

const counts = (record: Record<string, number>) =>
  Object.entries(record)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ") || "none";

/** Renders the human-readable Markdown report. */
export function renderMarkdownReport(report: EvaluationReport): string {
  const { run, automated: a, human: h } = report;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# Image understanding evaluation${run.synthetic ? " — SYNTHETIC (tooling test, not a benchmark)" : ""}`, "");
  push("## Scope", "", ...report.scope.map((s) => `> ${s}`), "");

  push("## 1. Run summary", "");
  push(
    ...table(
      ["Field", "Value"],
      [
        ["Run id", run.runId],
        ["Generated", run.generatedAt],
        ["Dataset", `${run.datasetId} v${run.datasetVersion} (${run.datasetPurpose})`],
        ["Data sources of runs in use", counts(run.dataSources)],
        ["Usable predictions", run.usablePredictions],
        ["Reviewers", run.reviewers.join(", ") || "none"],
      ],
    ),
    "",
  );

  push("## 2. Model and instructions", "");
  push(
    ...table(
      ["Setting", "Baseline", "Observed in runs"],
      [
        ["Model", run.baseline.model, run.observedModels.join(", ") || "—"],
        ["Instructions version", run.baseline.instructionsVersion, run.observedInstructionVersions.join(", ") || "—"],
        ["Image detail", run.baseline.imageDetail, ""],
        ["Reasoning effort", run.baseline.reasoningEffort, ""],
        ["Max output tokens", run.baseline.maxOutputTokens, ""],
      ],
    ),
    "",
    "Runs that differ from the baseline settings are excluded from metrics and listed under Missing evaluations.",
    "",
  );

  const comp = report.composition;
  push("## 3. Dataset composition", "");
  const groups = [...new Set([...Object.keys(comp.byGroup), ...Object.keys(comp.plannedComposition ?? {})])].sort();
  push(
    ...table(["Group", "Defined cases", "Planned"], groups.map((g) => [g, comp.byGroup[g] ?? 0, comp.plannedComposition?.[g] ?? "—"])),
    "",
    `Defined ${comp.declaredCases}${comp.plannedTotal !== null ? ` of ${comp.plannedTotal} planned` : ""} case(s). Annotation status: ${counts(comp.annotationStatus)}.`,
    "",
  );

  push("## 4. Automated metrics", "", "Completeness counts describe how much was extracted, not whether it is correct.", "");
  push(
    ...table(
      ["Metric", "Result", "Denominator"],
      [
        ["Cases with a run in use", ratioCell(a.casesWithRun), a.casesWithRun.of],
        ["Model returned an outcome", ratioCell(a.modelResponded), a.modelResponded.of],
        ["Expected outcome", ratioCell(a.expectedOutcome), a.expectedOutcome.of],
        ["Category", ratioCell(a.category), a.category.of],
      ],
    ),
    "",
    `Run errors: ${counts(a.runErrors)}.`,
    "",
    "Outcome confusion (rows: expected, columns: model outcome):",
    "",
    ...table(
      ["Expected", "furniture_identified", "no_furniture", "ambiguous_target", "unreadable_image", "error"],
      a.outcomeConfusion.map((row) => [row.expected, row.predicted.furniture_identified, row.predicted.no_furniture, row.predicted.ambiguous_target, row.predicted.unreadable_image, row.predicted.error]),
    ),
    "",
    "Subtypes (compare semantically during review; not scored):",
    "",
    ...table(["Case", "Model subtype", "Acceptable (annotator)"], a.subtypes.map((s) => [s.caseId, s.predicted ?? "—", s.acceptable.join("; ") || "—"])),
    "",
    `Completeness over ${a.completeness.predictions} ${a.completeness.of}:`,
    "",
    ...table(
      ["Measure", "Value"],
      [
        ["Structure features", statsCell(a.completeness.structureFeatures)],
        ["Appearance features", statsCell(a.completeness.appearanceFeatures)],
        ["Distinctive features", statsCell(a.completeness.distinctiveFeatures)],
        ["Certainty totals", counts(a.completeness.certaintyTotals)],
        ["Search queries per run", statsCell(a.completeness.searchQueries)],
        ["Runs without queries / empty / duplicate queries", `${a.completeness.predictionsWithoutQueries} / ${a.completeness.emptyQueries} / ${a.completeness.duplicateQueries}`],
      ],
    ),
    "",
    `Token usage over ${a.usage.runsWithUsage} ${a.usage.of} (${a.usage.runsWithoutUsage} without usage). Reasoning tokens are included in output tokens. No cost is estimated.`,
    "",
    ...table(
      ["Measure", "Value"],
      [
        ["Input tokens", statsCell(a.usage.inputTokens)],
        ["Output tokens", statsCell(a.usage.outputTokens)],
        ["Total tokens", statsCell(a.usage.totalTokens)],
        ["Reasoning tokens (subset of output)", statsCell(a.usage.reasoningTokens)],
        ["Duration (ms)", statsCell(a.usage.durationMs)],
        ["Records where input + output ≠ total", a.usage.inconsistentTotals],
      ],
    ),
    "",
  );

  push("## 5. Human-reviewed metrics", "");
  const rs = h.reviewStatus;
  push(`Reviews: ${rs.complete} complete, ${rs.inProgress} in progress, ${rs.notStarted} not started, of ${rs.casesWithRun} case(s) with a run. Only complete reviews count; "not_reviewed" items are excluded from denominators.`, "");
  if (rs.complete === 0) {
    push("_No complete reviews yet; no human-reviewed metrics are reported._", "");
  } else {
    const fc = (label: string, c: typeof h.criticalFeatures) => [
      label,
      ratioCell(c.captured),
      ratioCell(c.capturedOrPartial),
      ratioCell(c.missedOrContradicted),
      `${c.judged} judged of ${c.declaredInReviewedCases}`,
    ];
    push(
      ...table(
        ["Metric", "Result", "Denominator"],
        [
          ["Correct primary object", ratioCell(h.objectSelection.correct), h.objectSelection.correct.of],
          ["Uncertainty appropriate", ratioCell(h.uncertainty.appropriate), h.uncertainty.appropriate.of],
          ["Reviews with unsupported assertions", ratioCell(h.unsupportedAssertions.reviewsWithAny), h.unsupportedAssertions.reviewsWithAny.of],
        ],
      ),
      "",
      ...table(["Features", "Captured", "Captured or partial", "Missed or contradicted", "Coverage"], [fc("Critical", h.criticalFeatures), fc("Supporting", h.supportingFeatures), fc("Distinctive", h.distinctiveFeatures)]),
      "",
      `Unsupported assertions: ${h.unsupportedAssertions.total} (${counts(h.unsupportedAssertions.byType)}).`,
      `Uncertainty judgements: ${counts(h.uncertainty.counts)}.`,
      `Search-query rating (${h.searchQueries.note}): ${statsCell(h.searchQueries.rating)}; distribution ${counts(Object.fromEntries(Object.entries(h.searchQueries.ratingDistribution).map(([k, v]) => [`${k}★`, v])))}.`,
      `Query flags (yes/no/unanswered): ${Object.entries(h.searchQueries.flags).map(([k, v]) => `${k} ${v.yes}/${v.no}/${v.unanswered}`).join("; ")}.`,
      `Failure tags: ${h.failureTags.map((t) => `${t.tag} ${t.count}`).join(", ") || "none"}.`,
      "",
    );
  }

  const breakdownRows = (rows: EvaluationReport["byGroup"]) =>
    rows.map((r) => [r.key, r.cases, r.withRun, r.errors, ratioCell(r.outcomeCorrect), ratioCell(r.categoryCorrect), r.completeReviews, ratioCell(r.criticalCaptured)]);
  const breakdownHeaders = ["Key", "Cases", "With run", "Errors", "Expected outcome", "Category", "Complete reviews", "Critical captured"];
  push("## 6. Results by group", "", ...table(breakdownHeaders, breakdownRows(report.byGroup)), "");
  push("## 7. Results by image condition", "", "A case can have several conditions.", "", ...table(breakdownHeaders, breakdownRows(report.byCondition)), "");

  push("## 8. Notable failures", "", ...table(["Case", "Kind", "Detail"], report.notableFailures.map((f) => [f.caseId, f.kind, f.detail.replace(/\|/g, "\\|")])), "");

  const m = report.missing;
  push("## 9. Missing evaluations", "");
  push(`- Cases without a run in use: ${m.casesWithoutRun.join(", ") || "none"}`);
  push(`- Cases with a run but no complete review: ${m.casesWithoutCompleteReview.join(", ") || "none"}`);
  push(`- Image checks needing attention: ${m.imageChecks.map((c) => `${c.caseId} (${c.status})`).join(", ") || "none"}`, "");
  push("Files not used:", "", ...table(["File", "Case", "Problem", "Detail"], [
    ...m.loadIssues.map((i) => [i.file, "—", i.problem, i.detail.replace(/\|/g, "\\|")]),
    ...m.associationIssues.map((i) => [i.file, i.caseId ?? "—", i.problem, i.detail]),
  ]), "");

  push("## 10. Recommended areas for investigation", "", ...report.recommendations.map((r) => `- ${r}`), "");
  return lines.join("\n");
}

export function renderJsonReport(report: EvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
