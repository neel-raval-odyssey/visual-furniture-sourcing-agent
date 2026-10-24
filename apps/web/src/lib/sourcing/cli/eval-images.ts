import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluate, type ImageCheck } from "../evaluation/engine";
import { checkLocalImages, EvaluationInputError, loadDataset, loadRecordDirectory } from "../evaluation/load";
import { renderJsonReport, renderMarkdownReport } from "../evaluation/report";
import { createReviewSkeleton, reviewRecordSchema } from "../evaluation/review";
import { runRecordSchema } from "../evaluation/run-record";
import type { CliIO } from "./analyze-image";

/**
 * Offline evaluator. Reads files only: it never contacts OpenAI or any
 * marketplace and does not read API keys.
 */

export const EVAL_EXIT_OK = 0;
export const EVAL_EXIT_USAGE = 2;

export interface EvalImagesCliDeps {
  io: CliIO;
  /** Directory user-supplied relative paths are resolved against. */
  cwd: string;
  /** Repository root, for default paths. */
  repoRoot: string;
  now?: () => Date;
}

export const EVAL_USAGE = `Evaluate saved image-understanding runs offline (no API calls).

Usage:
  pnpm eval:images [--dataset <file>] [--predictions <dir>] [--reviews <dir>]
                   [--images <file>] [--output <dir>] [--force]
  pnpm eval:images --init-review <case-id> [--dataset <file>] [--predictions <dir>] [--reviews <dir>]

Defaults (relative to the repository root):
  --dataset      evals/image-understanding/dataset.json
  --predictions  evals/local/predictions
  --reviews      evals/local/reviews
  --output       evals/local/reports       (writes report.json and report.md)

Options:
  --images <file>        Private case-id → image-path mapping; checks image hashes
  --force                Replace existing report.json / report.md in --output
  --init-review <id>     Write a blank review for a case to <reviews>/<id>.json
  -h, --help             Show this help`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runEvalImagesCli(argv: string[], deps: EvalImagesCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        dataset: { type: "string" },
        predictions: { type: "string" },
        reviews: { type: "string" },
        images: { type: "string" },
        output: { type: "string" },
        force: { type: "boolean", default: false },
        "init-review": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(EVAL_USAGE);
    return EVAL_EXIT_USAGE;
  }
  if (values.help) {
    io.out(EVAL_USAGE);
    return EVAL_EXIT_OK;
  }

  const path = (value: unknown, fallback: string) =>
    typeof value === "string" ? resolve(deps.cwd, value) : resolve(deps.repoRoot, fallback);
  const datasetPath = path(values.dataset, "evals/image-understanding/dataset.json");
  const predictionsDir = path(values.predictions, "evals/local/predictions");
  const reviewsDir = path(values.reviews, "evals/local/reviews");
  const outputDir = path(values.output, "evals/local/reports");
  const now = deps.now ?? (() => new Date());

  try {
    const dataset = await loadDataset(datasetPath);
    const runs = await loadRecordDirectory(predictionsDir, runRecordSchema);

    const initCase = values["init-review"];
    if (typeof initCase === "string") {
      const c = dataset.cases.find((x) => x.id === initCase);
      if (!c) {
        io.err(`Error: case "${initCase}" is not in the dataset`);
        return EVAL_EXIT_USAGE;
      }
      const latest = runs.records
        .filter((r) => r.record.caseId === c.id)
        .sort((a, b) => b.record.recordedAt.localeCompare(a.record.recordedAt))[0];
      const target = join(reviewsDir, `${c.id}.json`);
      if (await exists(target)) {
        io.err(`Error: ${target} already exists; reviews are never overwritten`);
        return EVAL_EXIT_USAGE;
      }
      await mkdir(reviewsDir, { recursive: true });
      const skeleton = createReviewSkeleton(c, latest?.record.response.responseId ?? null);
      await writeFile(target, `${JSON.stringify(skeleton, null, 2)}\n`, { flag: "wx" });
      io.out(`Wrote a blank review for ${c.id} to ${target}${latest ? "" : " (no run found yet; responseId is null)"}`);
      return EVAL_EXIT_OK;
    }

    const reviews = await loadRecordDirectory(reviewsDir, reviewRecordSchema);
    let imageChecks: ImageCheck[] | undefined;
    if (typeof values.images === "string") imageChecks = await checkLocalImages(resolve(deps.cwd, values.images), dataset);

    const jsonPath = join(outputDir, "report.json");
    const mdPath = join(outputDir, "report.md");
    if (!values.force && ((await exists(jsonPath)) || (await exists(mdPath)))) {
      io.err(`Error: a report already exists in ${outputDir}; use --force to replace it or choose another --output`);
      return EVAL_EXIT_USAGE;
    }

    const generatedAt = now().toISOString();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([dataset, runs.records, reviews.records]))
      .digest("hex")
      .slice(0, 8);
    const runId = `eval-${generatedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${fingerprint}`;

    const report = evaluate({
      dataset,
      runs: runs.records,
      reviews: reviews.records,
      loadIssues: [...runs.issues, ...reviews.issues],
      imageChecks,
      generatedAt,
      runId,
    });

    await mkdir(outputDir, { recursive: true });
    await writeFile(jsonPath, renderJsonReport(report));
    await writeFile(mdPath, renderMarkdownReport(report));

    const a = report.automated;
    if (report.run.synthetic) io.out("SYNTHETIC: tooling test only; this does not measure real model quality.");
    io.out(`Run ${report.run.runId}: ${a.casesWithRun.numerator} of ${a.casesWithRun.denominator} case(s) with a run, ${report.human.reviewStatus.complete} complete review(s).`);
    if (!runs.directoryFound) io.out(`Note: predictions folder not found (${predictionsDir}).`);
    if (!reviews.directoryFound) io.out(`Note: reviews folder not found (${reviewsDir}).`);
    io.out(`Wrote ${jsonPath}`);
    io.out(`Wrote ${mdPath}`);
    return EVAL_EXIT_OK;
  } catch (error) {
    if (error instanceof EvaluationInputError) {
      io.err(`Error: ${error.message}`);
      return EVAL_EXIT_USAGE;
    }
    throw error;
  }
}
