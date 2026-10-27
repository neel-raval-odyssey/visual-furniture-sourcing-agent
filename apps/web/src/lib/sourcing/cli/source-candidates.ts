import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CandidateAssociationError,
  importCuratedCandidates,
  MissingCandidateInputError,
} from "../discovery/curated/curated-alibaba-adapter";
import { renderSearchHandoff } from "../discovery/curated/handoff";
import { candidateManifestSchema, createManifestTemplate, type CandidateManifest } from "../discovery/curated/manifest";
import { renderCuratedRunSummary, summarizeCuratedRun } from "../discovery/curated/summary";
import { createCuratedSourcingPipeline } from "../pipeline/curated";
import { SourcingPipelineError } from "../pipeline/errors";
import { DEFAULT_CANDIDATE_LIMIT } from "../pipeline/sourcing-pipeline";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { summarizeIssues } from "../validation/issues";
import type { CliIO } from "./analyze-image";

/**
 * Operator-assisted Alibaba.com candidate intake. Reads and writes local files
 * only: it never contacts Alibaba.com, OpenAI or any other service, and never
 * reads API keys.
 */

export const SOURCE_EXIT_OK = 0;
/** The manifest or run record is invalid, or the run failed. */
export const SOURCE_EXIT_INVALID = 1;
/** Usage error or missing input (no run record, no manifest, manifest not filled in). */
export const SOURCE_EXIT_USAGE = 2;

export interface SourceCandidatesCliDeps {
  io: CliIO;
  /** Directory user-supplied relative paths are resolved against. */
  cwd: string;
  /** Repository root, for default paths. */
  repoRoot: string;
}

export const SOURCE_USAGE = `Operator-assisted Alibaba.com candidate intake (offline; searches nothing).

Usage:
  pnpm source:candidates --case <id> --prepare   Print the search handoff; write a blank manifest
  pnpm source:candidates --case <id> --validate  Validate the filled-in manifest
  pnpm source:candidates --case <id> --run       Import candidates and print a sourcing result

Options:
  --predictions <dir>   Folder with saved runs (default evals/local/predictions); uses <dir>/<case>.json
  --record <file>       A specific saved run record instead of <predictions>/<case>.json
  --candidates <dir>    Manifest folder (default evals/local/candidates); uses <dir>/<case>.json
  --manifest <file>     A specific manifest; repeat to combine several for the same case
  --limit <n>           Maximum candidates to return with --run (default ${DEFAULT_CANDIDATE_LIMIT})
  --json                Print JSON (summary plus the full sourcing result) instead of text
  --synthetic           Allow synthetic run records and manifests (output is labelled SYNTHETIC)
  -h, --help            Show this help

Default folders are relative to the repository root; other relative paths are
relative to where you run the command.`;

export class InputProblem extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface LoadedManifest {
  path: string;
  manifest: CandidateManifest;
}

export async function loadManifest(path: string, display: string): Promise<LoadedManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InputProblem(
        SOURCE_EXIT_USAGE,
        `No candidate manifest at ${display}. This is missing input, not evidence that Alibaba.com has no matches. Create one with --prepare.`,
      );
    }
    throw new InputProblem(SOURCE_EXIT_INVALID, `Manifest ${display} cannot be read`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InputProblem(SOURCE_EXIT_INVALID, `Manifest ${display} is not valid JSON`);
  }
  const parsed = candidateManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputProblem(SOURCE_EXIT_INVALID, `Manifest ${display} is invalid: ${summarizeIssues(parsed.error)}`);
  }
  return { path, manifest: parsed.data };
}

/**
 * Association, provenance and local-evidence checks that need the saved run and the file system.
 * `checkLocalFiles: false` skips the file-existence check for callers that report missing evidence themselves.
 */
export async function checkManifest(
  loaded: LoadedManifest,
  saved: SavedFingerprint,
  display: string,
  synthetic: boolean,
  { checkLocalFiles = true }: { checkLocalFiles?: boolean } = {},
): Promise<string[]> {
  const m = loaded.manifest;
  const problems: string[] = [];
  if (m.caseId !== saved.caseId) problems.push(`caseId is "${m.caseId}", expected "${saved.caseId}"`);
  if (m.referenceImageId !== saved.reference.id) {
    problems.push(`referenceImageId is "${m.referenceImageId}", expected "${saved.reference.id}"`);
  }
  if (m.fingerprintId !== saved.fingerprint.id) {
    problems.push(`fingerprintId is "${m.fingerprintId}", but the saved run has "${saved.fingerprint.id}" (prepared from another run?)`);
  }
  if (m.dataSource === "mock" && !synthetic) problems.push('dataSource is "mock": pass --synthetic to use synthetic manifests');
  if (m.dataSource === "live" && saved.fingerprint.source.dataSource === "mock") {
    problems.push("genuine (live) candidates cannot be attached to a synthetic fingerprint");
  }
  for (const [i, c] of checkLocalFiles ? m.candidates.entries() : []) {
    for (const [j, img] of c.images.entries()) {
      if ("localPath" in img && !(await exists(join(dirname(loaded.path), img.localPath)))) {
        problems.push(`candidates[${i}].images[${j}].localPath: file not found next to ${display}`);
      }
    }
  }
  return problems.map((p) => `Manifest ${display}: ${p}`);
}

export async function runSourceCandidatesCli(argv: string[], deps: SourceCandidatesCliDeps): Promise<number> {
  const { io } = deps;
  let values: {
    case?: string;
    prepare?: boolean;
    validate?: boolean;
    run?: boolean;
    predictions?: string;
    record?: string;
    candidates?: string;
    manifest?: string[];
    limit?: string;
    json?: boolean;
    synthetic?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        case: { type: "string" },
        prepare: { type: "boolean", default: false },
        validate: { type: "boolean", default: false },
        run: { type: "boolean", default: false },
        predictions: { type: "string" },
        record: { type: "string" },
        candidates: { type: "string" },
        manifest: { type: "string", multiple: true },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        synthetic: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(SOURCE_USAGE);
    return SOURCE_EXIT_USAGE;
  }
  if (values.help) {
    io.out(SOURCE_USAGE);
    return SOURCE_EXIT_OK;
  }
  const usage = (message: string) => {
    io.err(`Error: ${message}`);
    io.err(SOURCE_USAGE);
    return SOURCE_EXIT_USAGE;
  };
  const caseId = values.case;
  if (!caseId || !/^[a-z0-9][a-z0-9-]*$/.test(caseId)) return usage("--case <id> is required (lower-case letters, digits, hyphens)");
  const modes = (["prepare", "validate", "run"] as const).filter((m) => values[m]);
  if (modes.length !== 1) return usage("choose exactly one of --prepare, --validate or --run");
  const mode = modes[0];
  let limit = DEFAULT_CANDIDATE_LIMIT;
  if (values.limit !== undefined) {
    if (mode !== "run") return usage("--limit only applies to --run");
    if (!/^[1-9]\d*$/.test(values.limit)) return usage("--limit must be a positive whole number");
    limit = Number(values.limit);
  }
  const synthetic = values.synthetic === true;

  const fromCwd = (p: string) => resolve(deps.cwd, p);
  const dirOr = (value: string | undefined, fallback: string) => (value ? fromCwd(value) : resolve(deps.repoRoot, fallback));
  const display = (p: string) => {
    const rel = relative(deps.repoRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const recordPath = values.record ? fromCwd(values.record) : join(dirOr(values.predictions, "evals/local/predictions"), `${caseId}.json`);
  const manifestPaths = values.manifest?.length
    ? values.manifest.map(fromCwd)
    : [join(dirOr(values.candidates, "evals/local/candidates"), `${caseId}.json`)];

  try {
    let saved: SavedFingerprint;
    try {
      saved = await loadSavedFingerprint(recordPath, caseId);
    } catch (error) {
      if (error instanceof SavedRunError) {
        throw new InputProblem(error.problem === "missing_record" ? SOURCE_EXIT_USAGE : SOURCE_EXIT_INVALID, error.message);
      }
      throw error;
    }
    if (saved.fingerprint.source.dataSource === "mock" && !synthetic) {
      throw new InputProblem(SOURCE_EXIT_USAGE, `Run record ${display(recordPath)} is synthetic: pass --synthetic to use it`);
    }
    // With --json, notices go to stderr so stdout stays valid JSON; the summary carries `synthetic` too.
    const notice = values.json ? io.err : io.out;
    if (saved.fingerprint.source.dataSource === "mock") notice("SYNTHETIC: the reference fingerprint is synthetic.");

    if (mode === "prepare") {
      if (manifestPaths.length !== 1) return usage("--prepare takes at most one --manifest");
      const target = manifestPaths[0];
      let note: string;
      if (await exists(target)) {
        note = `Manifest ${display(target)} already exists and was not changed.`;
      } else {
        await mkdir(dirname(target), { recursive: true });
        const template = createManifestTemplate({
          caseId,
          referenceImageId: saved.reference.id,
          fingerprintId: saved.fingerprint.id,
          dataSource: saved.fingerprint.source.dataSource,
        });
        await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
        note = `Wrote a blank manifest to ${display(target)} (capture.status "not_started").`;
      }
      io.out(renderSearchHandoff(saved, display(target), caseId));
      io.out("");
      io.out(note);
      return SOURCE_EXIT_OK;
    }

    const loaded: LoadedManifest[] = [];
    const problems: string[] = [];
    for (const path of manifestPaths) {
      try {
        const m = await loadManifest(path, display(path));
        loaded.push(m);
        problems.push(...(await checkManifest(m, saved, display(path), synthetic)));
      } catch (error) {
        if (error instanceof InputProblem && error.exitCode === SOURCE_EXIT_INVALID) problems.push(error.message);
        else throw error;
      }
    }
    if (problems.length > 0) {
      for (const p of problems) io.err(`Invalid: ${p}`);
      return SOURCE_EXIT_INVALID;
    }
    const manifests = loaded.map((l) => l.manifest);
    const unfinished = loaded.filter((l) => l.manifest.capture.status !== "completed");
    const isSynthetic = manifests.some((m) => m.dataSource === "mock") || saved.fingerprint.source.dataSource === "mock";

    if (mode === "validate") {
      if (isSynthetic) notice("SYNTHETIC: contains synthetic data; these are not real Alibaba.com listings.");
      for (const l of loaded) {
        const m = l.manifest;
        const status =
          m.capture.status === "completed"
            ? `${m.candidates.length} candidate(s), ${m.suppliers.length} supplier(s), captured ${m.capture.capturedAt}`
            : "not filled in yet (capture.status is \"not_started\")";
        io.out(`Valid: ${display(l.path)}: ${m.dataSource === "mock" ? "synthetic" : "genuine"} manifest for ${m.caseId}; ${status}.`);
      }
      if (unfinished.length === 0) {
        const imported = importCuratedCandidates(manifests);
        const unsuitable = imported.info.filter((i) => !i.imageEvidence.suitableForVisualComparison).length;
        io.out(
          `Would import ${imported.listings.length} listing(s) and ${imported.suppliers.length} supplier(s); ${imported.skippedDuplicates.length} duplicate(s) across manifests; ${unsuitable} without image evidence.`,
        );
      }
      return SOURCE_EXIT_OK;
    }

    if (unfinished.length > 0) {
      throw new InputProblem(
        SOURCE_EXIT_USAGE,
        `Manifest ${display(unfinished[0].path)} is not filled in yet (capture.status "not_started"). This is missing input, not an empty search result.`,
      );
    }

    const { pipeline, discovery } = createCuratedSourcingPipeline({ fingerprint: saved.fingerprint, manifests });
    const run = await pipeline.run({ reference: saved.reference, discovery: { limit, mode: "image_and_text" } });
    const summary = summarizeCuratedRun(run, discovery.lastImport!, caseId);
    if (values.json) io.out(JSON.stringify({ summary, result: run }, null, 2));
    else io.out(renderCuratedRunSummary(summary));
    return SOURCE_EXIT_OK;
  } catch (error) {
    if (error instanceof InputProblem) {
      io.err(`Error: ${error.message}`);
      return error.exitCode;
    }
    const cause = error instanceof SourcingPipelineError ? error.cause : error;
    if (cause instanceof MissingCandidateInputError) {
      io.err(`Error: ${cause.message}`);
      return SOURCE_EXIT_USAGE;
    }
    if (cause instanceof CandidateAssociationError || error instanceof SourcingPipelineError) {
      io.err(`Error: ${(error as Error).message}`);
      return SOURCE_EXIT_INVALID;
    }
    throw error;
  }
}
