import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRunForResume, runOrchestration, type OrchestrationOutcome, type OrchestratorConfig } from "../orchestration/orchestrator";
import { RunJournalError, type CandidateSourceSpec, type SelectionPolicy } from "../orchestration/journal";
import { StageError } from "../orchestration/stages";
import { PythonImageSimilarityRunner, type ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { DEFAULT_MODEL_ID, MODEL_ID_PATTERN } from "../shortlisting/protocol";
import { VISUAL_VERIFICATION_INSTRUCTIONS_VERSION } from "../verification/openai/instructions";
import { DEFAULT_VERIFICATION_REQUEST_SETTINGS, DEFAULT_VISUAL_VERIFICATION_MODEL } from "../verification/openai/verification-client";
import type { CliIO } from "./analyze-image";

/**
 * Automated sourcing orchestration: one command from a saved reference to a
 * consolidated sourcing result, composing candidate intake or saved discovery,
 * image checks, the SigLIP 2 shortlist and saved Sol assessments. This version
 * runs offline only: it never contacts a marketplace provider, downloads
 * images or models, or sends a paid request.
 */

export const SOURCE_AUTO_EXIT_OK = 0;
export const SOURCE_AUTO_EXIT_INVALID = 1;
export const SOURCE_AUTO_EXIT_USAGE = 2;
/** A stage is blocked (missing prerequisite or authorization). */
export const SOURCE_AUTO_EXIT_BLOCKED = 3;
/** A result was produced, but with missing evidence or unverified candidates. */
export const SOURCE_AUTO_EXIT_PARTIAL = 4;

export interface SourceAutoCliDeps {
  io: CliIO;
  cwd: string;
  repoRoot: string;
  /** Local SigLIP 2 component (tests substitute it); defaults to services/vision. */
  runner?: ImageSimilarityRunner | null;
  now?: () => Date;
}

export const SOURCE_AUTO_USAGE = `Automated sourcing orchestration (offline in this version: no marketplace, download or paid requests).

Usage:
  pnpm source:auto --case <id> --source curated [--manifest <file>] --plan
  pnpm source:auto --case <id> --source curated [--manifest <file>] --run --offline
  pnpm source:auto --case <id> --source provider-run --discovery-run <folder> --plan | --run --offline
  pnpm source:auto --case <id> --source provider-live --plan        (shows the blocked live-discovery prerequisites)
  pnpm source:auto --case <id> --resume <run id> --offline

Options:
  --selection all|top-k     Verification selection (default all); --top-k <n> with top-k
  --shortlist <file>        A specific saved SigLIP shortlist to reuse (checked for compatibility)
  --no-recompute            Never compute a new SigLIP shortlist, even with a cached local checkpoint
  --siglip-model <id>       Default ${DEFAULT_MODEL_ID}
  --prefer-latest-verification   If several compatible Sol records exist, use the latest (otherwise reported as ambiguous)
  --predictions <dir>, --record <file>, --images <file>, --verifications-dir <dir>, --shortlists-dir <dir>, --runs-dir <dir>
  --synthetic               Allow synthetic fingerprints, manifests and discovery runs (output labelled SYNTHETIC)
  --json                    Print JSON
  -h, --help                Show this help

Paid Sol requests and live discovery are never run here; the output lists the separately authorized commands.`;

function exitFor(outcome: OrchestrationOutcome): number {
  if (outcome.status === "completed") return SOURCE_AUTO_EXIT_OK;
  if (outcome.status === "partial") return SOURCE_AUTO_EXIT_PARTIAL;
  if (outcome.status === "failed") return SOURCE_AUTO_EXIT_INVALID;
  if (outcome.status === "blocked") return SOURCE_AUTO_EXIT_BLOCKED;
  return SOURCE_AUTO_EXIT_OK; // plan without blockers
}

export async function runSourceAutoCli(argv: string[], deps: SourceAutoCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        case: { type: "string" },
        source: { type: "string" },
        manifest: { type: "string" },
        "discovery-run": { type: "string" },
        plan: { type: "boolean", default: false },
        run: { type: "boolean", default: false },
        resume: { type: "string" },
        offline: { type: "boolean", default: false },
        selection: { type: "string" },
        "top-k": { type: "string" },
        shortlist: { type: "string" },
        "no-recompute": { type: "boolean", default: false },
        "siglip-model": { type: "string" },
        "prefer-latest-verification": { type: "boolean", default: false },
        predictions: { type: "string" },
        record: { type: "string" },
        images: { type: "string" },
        "verifications-dir": { type: "string" },
        "shortlists-dir": { type: "string" },
        "runs-dir": { type: "string" },
        synthetic: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(SOURCE_AUTO_USAGE);
    return SOURCE_AUTO_EXIT_USAGE;
  }
  if (values.help) {
    io.out(SOURCE_AUTO_USAGE);
    return SOURCE_AUTO_EXIT_OK;
  }
  const usage = (m: string) => {
    io.err(`Error: ${m}`);
    io.err(SOURCE_AUTO_USAGE);
    return SOURCE_AUTO_EXIT_USAGE;
  };
  const str = (k: string) => values[k] as string | undefined;
  const flag = (k: string) => values[k] === true;
  const caseId = str("case");
  if (!caseId || !/^[a-z0-9][a-z0-9-]*$/.test(caseId)) return usage("--case <id> is required (lower-case letters, digits, hyphens)");
  const modes = [flag("plan") && "plan", flag("run") && "run", str("resume") !== undefined && "resume"].filter(Boolean) as string[];
  if (modes.length !== 1) return usage("choose exactly one of --plan, --run or --resume <run id>");
  const mode = modes[0] as "plan" | "run" | "resume";
  if (mode !== "plan" && !flag("offline")) {
    return usage("this version executes offline only: add --offline (no marketplace, image-download or paid model requests are made)");
  }

  const display = (p: string) => {
    const rel = relative(deps.repoRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const fromCwd = (p: string) => resolve(deps.cwd, p);
  const dirOr = (value: string | undefined, fallback: string) => (value ? fromCwd(value) : resolve(deps.repoRoot, fallback));
  const resolveStored = (p: string) => (isAbsolute(p) ? p : resolve(deps.repoRoot, p));
  const runsDir = dirOr(str("runs-dir"), "evals/local/sourcing-runs");
  const paths: OrchestratorConfig["paths"] = {
    recordPath: str("record") ? fromCwd(str("record")!) : join(dirOr(str("predictions"), "evals/local/predictions"), `${caseId}.json`),
    imagesMapPath: dirOr(str("images"), "evals/local/images.json"),
    shortlistsDir: dirOr(str("shortlists-dir"), "evals/local/shortlists"),
    verificationsDir: dirOr(str("verifications-dir"), "evals/local/verifications"),
    runsDir,
    resolve: resolveStored,
    display,
  };
  const runner =
    deps.runner !== undefined
      ? deps.runner
      : new PythonImageSimilarityRunner({ python: join(deps.repoRoot, "services/vision/.venv/bin/python"), serviceDir: join(deps.repoRoot, "services/vision") });
  const now = () => deps.now?.() ?? new Date();

  let config: OrchestratorConfig;
  let resume: Awaited<ReturnType<typeof loadRunForResume>> | undefined;
  try {
    if (mode === "resume") {
      resume = await loadRunForResume(runsDir, caseId, str("resume")!);
      if (resume.journal.status === "completed") {
        io.out(`Run ${resume.journal.runId} is already completed; nothing to resume. Result: ${display(join(resume.runDir, "result.md"))}`);
        return SOURCE_AUTO_EXIT_OK;
      }
      const i = resume.journal.inputs;
      config = { caseId, source: i.source, synthetic: i.synthetic, selection: i.selection, siglip: i.siglip, sol: i.sol, preferLatestVerification: i.preferLatestVerification, paths, runner, now };
    } else {
      const kind = str("source");
      let source: CandidateSourceSpec;
      if (kind === "curated") source = { kind, manifest: display(str("manifest") ? fromCwd(str("manifest")!) : resolve(deps.repoRoot, `evals/local/candidates/${caseId}.json`)) };
      else if (kind === "provider-run") {
        if (!str("discovery-run")) return usage("--source provider-run needs --discovery-run <folder>");
        source = { kind, discoveryRun: display(fromCwd(str("discovery-run")!)) };
      } else if (kind === "provider-live") {
        if (mode !== "plan") return usage("--source provider-live can only be planned: live acquisition is not authorized");
        source = { kind };
      } else return usage("--source curated|provider-run|provider-live is required");
      let selection: SelectionPolicy = { kind: "all" };
      const sel = str("selection") ?? "all";
      if (sel === "top-k") {
        if (!/^[1-9]\d*$/.test(str("top-k") ?? "")) return usage("--selection top-k needs --top-k <n>");
        selection = { kind: "top-k", k: Number(str("top-k")) };
      } else if (sel !== "all") return usage("--selection must be all or top-k");
      else if (str("top-k")) return usage("--top-k requires --selection top-k");
      const modelId = str("siglip-model") ?? DEFAULT_MODEL_ID;
      if (!MODEL_ID_PATTERN.test(modelId)) return usage("--siglip-model must be an official google/siglip2-* checkpoint");
      config = {
        caseId,
        source,
        synthetic: flag("synthetic"),
        selection,
        siglip: { modelId, allowRecompute: !flag("no-recompute"), shortlist: str("shortlist") ? display(fromCwd(str("shortlist")!)) : null },
        sol: {
          model: DEFAULT_VISUAL_VERIFICATION_MODEL,
          instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
          imageDetail: DEFAULT_VERIFICATION_REQUEST_SETTINGS.imageDetail,
          reasoningEffort: DEFAULT_VERIFICATION_REQUEST_SETTINGS.reasoningEffort,
        },
        preferLatestVerification: flag("prefer-latest-verification"),
        paths,
        runner,
        now,
      };
    }
  } catch (error) {
    if (error instanceof RunJournalError || error instanceof StageError) {
      io.err(`Error: ${error.message}`);
      return SOURCE_AUTO_EXIT_INVALID;
    }
    throw error;
  }

  const outcome = await runOrchestration(config, mode === "plan" ? "plan" : "run", resume);
  if (flag("json")) {
    io.out(JSON.stringify({ status: outcome.status, runId: outcome.runId, runDir: outcome.runDir ? display(outcome.runDir) : null, stages: outcome.stages, identicalRuns: outcome.identicalRuns, warnings: outcome.warnings, followUps: outcome.followUps, plan: outcome.details, result: outcome.result }, null, 2));
    return exitFor(outcome);
  }
  const L: string[] = [];
  L.push(mode === "plan" ? `# Sourcing plan: ${caseId} (nothing written; no external request)` : `# Sourcing run ${outcome.runId}: ${outcome.status}`);
  for (const [name, s] of Object.entries(outcome.stages)) L.push(`- ${name}: ${s.state}${s.message ? ` — ${s.message}` : ""}`);
  L.push(...outcome.details);
  if (outcome.identicalRuns.length) L.push(`Earlier runs with identical inputs: ${outcome.identicalRuns.join(", ")} (results reused; no new external operation).`);
  const r = outcome.result;
  if (r) {
    L.push("", `Verification ordering (Sol design similarity index; SigLIP shown for reference, never combined):`);
    for (const e of r.verified) {
      const v = e.verification;
      L.push(
        `  ${v.verificationRank}. ${e.marketplaceProductId ?? e.listingId}  Sol ${v.designSimilarityIndex} ${v.classification} (${v.confidence})  SigLIP rank ${e.retrieval.siglipRank ?? "—"} cos ${e.retrieval.embeddingCosineSimilarity?.toFixed(4) ?? "—"}  ${e.title.slice(0, 60)}`,
      );
      if (v.partialStructuralDifferences.length) L.push(`     partial differences: ${v.partialStructuralDifferences.map((x) => `${x.feature} (${x.reference ?? "?"} → ${x.candidate ?? "?"})`).join("; ")}`);
      if (v.structuralMismatches.length) L.push(`     mismatches: ${v.structuralMismatches.map((x) => x.feature).join(", ")}`);
    }
    for (const e of [...r.abstained, ...r.unverified]) L.push(`  unverified: ${e.marketplaceProductId ?? e.listingId} — ${e.verification.status}; image ${e.imageEvidence.status}`);
    L.push(`Counts: ${r.counts.candidates} candidates; ${r.counts.withLocalImage} with local image; ${r.counts.verified} verified; ${r.counts.unverified + r.counts.abstained} unverified. External requests made: 0.`);
    L.push(`Result: ${display(join(outcome.runDir!, "result.md"))} and result.json`);
  }
  for (const w of outcome.warnings) L.push(`Warning: ${w}`);
  for (const f of outcome.followUps) L.push(`Follow-up: ${f}`);
  if (mode === "plan" && outcome.status !== "blocked") L.push(`Output on --run --offline: ${display(join(runsDir, caseId))}/<run id>/result.json and result.md`);
  L.forEach((l) => io.out(l));
  return exitFor(outcome);
}
