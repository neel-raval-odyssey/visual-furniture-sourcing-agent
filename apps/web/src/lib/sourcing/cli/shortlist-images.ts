import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { importCuratedCandidates } from "../discovery/curated/curated-alibaba-adapter";
import { PythonImageSimilarityRunner, type ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { EvidenceError, planListingImages, resolveReferenceImage } from "../shortlisting/evidence";
import {
  DEFAULT_MODEL_ID,
  DEVICES,
  EmbeddingProtocolError,
  EmbeddingServiceError,
  MODEL_ID_PATTERN,
  type DeviceRequest,
  type EmbedOkResponse,
} from "../shortlisting/protocol";
import { renderShortlistMarkdown, renderShortlistText } from "../shortlisting/report";
import { buildEmbedRequest, buildVisualShortlist } from "../shortlisting/shortlist";
import { IMAGE_SELECTION_POLICY } from "../shortlisting/types";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import type { CliIO } from "./analyze-image";
import { checkManifest, InputProblem, loadManifest } from "./source-candidates";

/**
 * Visual shortlist of operator-captured Alibaba.com candidates: SigLIP 2 image
 * embeddings of the reference photograph and each candidate's local image,
 * ranked by cosine similarity. Reads local files only and runs the model
 * locally; it never fetches images, contacts Alibaba.com or OpenAI, or
 * downloads model weights.
 */

export const SHORTLIST_EXIT_OK = 0;
/** Invalid manifest, run record or image evidence. */
export const SHORTLIST_EXIT_INVALID = 1;
/** Usage error or missing input. */
export const SHORTLIST_EXIT_USAGE = 2;
/** The embedding component failed or returned an untrustworthy result. */
export const SHORTLIST_EXIT_EMBEDDING = 3;

export const DEFAULT_TOP_K = 10;

export interface ShortlistImagesCliDeps {
  io: CliIO;
  cwd: string;
  repoRoot: string;
  /** Substitute for the Python component (tests). */
  runner?: ImageSimilarityRunner;
  now?: () => Date;
}

export const SHORTLIST_USAGE = `Visual shortlist of recorded Alibaba.com candidates with local SigLIP 2 embeddings.

Usage:
  pnpm shortlist:images --case <id> --dry-run       Check inputs, images and environment (no model run)
  pnpm shortlist:images --case <id> [--top-k <n>]   Embed, rank by cosine similarity, save the report

Options:
  --top-k <n>           Number of candidates to shortlist (default ${DEFAULT_TOP_K})
  --model <id>          SigLIP 2 checkpoint (default ${DEFAULT_MODEL_ID}); must already be downloaded
  --revision <rev>      Checkpoint revision (commit hash) to require
  --device <d>          auto | mps | cpu (default auto; an explicit device is never switched)
  --json                Print the shortlist as JSON
  --no-save             Do not write the report files
  --output-dir <dir>    Report folder (default evals/local/shortlists)
  --predictions <dir>   Saved runs (default evals/local/predictions); uses <dir>/<case>.json
  --record <file>       A specific saved run record
  --candidates <dir>    Manifest folder (default evals/local/candidates); uses <dir>/<case>.json
  --manifest <file>     A specific manifest; local images must be in <its folder>/<case>/
  --images <file>       Reference image mapping (default evals/local/images.json)
  --python <file>       Python of the services/vision environment (default services/vision/.venv/bin/python)
  --synthetic           Allow synthetic run records and manifests (output is labelled SYNTHETIC)
  -h, --help            Show this help

Scores are raw cosine similarities: a ranking signal, not a confidence or a verified match.`;

export async function runShortlistImagesCli(argv: string[], deps: ShortlistImagesCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        case: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "top-k": { type: "string" },
        model: { type: "string" },
        revision: { type: "string" },
        device: { type: "string" },
        json: { type: "boolean", default: false },
        "no-save": { type: "boolean", default: false },
        "output-dir": { type: "string" },
        predictions: { type: "string" },
        record: { type: "string" },
        candidates: { type: "string" },
        manifest: { type: "string" },
        images: { type: "string" },
        python: { type: "string" },
        synthetic: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(SHORTLIST_USAGE);
    return SHORTLIST_EXIT_USAGE;
  }
  if (values.help) {
    io.out(SHORTLIST_USAGE);
    return SHORTLIST_EXIT_OK;
  }
  const usage = (message: string) => {
    io.err(`Error: ${message}`);
    io.err(SHORTLIST_USAGE);
    return SHORTLIST_EXIT_USAGE;
  };
  const str = (key: string) => values[key] as string | undefined;
  const caseId = str("case");
  if (!caseId || !/^[a-z0-9][a-z0-9-]*$/.test(caseId)) return usage("--case <id> is required (lower-case letters, digits, hyphens)");
  const dryRun = values["dry-run"] === true;
  let topK = DEFAULT_TOP_K;
  if (str("top-k") !== undefined) {
    if (!/^[1-9]\d*$/.test(str("top-k")!)) return usage("--top-k must be a positive whole number");
    topK = Number(str("top-k"));
  }
  const modelId = str("model") ?? DEFAULT_MODEL_ID;
  if (!MODEL_ID_PATTERN.test(modelId)) return usage("--model must be an official google/siglip2-* checkpoint id");
  const revision = str("revision") ?? null;
  if (revision !== null && !/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/.test(revision)) return usage("--revision has an invalid format");
  const device = (str("device") ?? "auto") as DeviceRequest;
  if (!DEVICES.includes(device)) return usage(`--device must be one of ${DEVICES.join(", ")}`);
  const synthetic = values.synthetic === true;
  const json = values.json === true;
  const notice = json ? io.err : io.out;

  const fromCwd = (p: string) => resolve(deps.cwd, p);
  const dirOr = (value: string | undefined, fallback: string) => (value ? fromCwd(value) : resolve(deps.repoRoot, fallback));
  const display = (p: string) => {
    const rel = relative(deps.repoRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const recordPath = str("record") ? fromCwd(str("record")!) : join(dirOr(str("predictions"), "evals/local/predictions"), `${caseId}.json`);
  const manifestPath = str("manifest") ? fromCwd(str("manifest")!) : join(dirOr(str("candidates"), "evals/local/candidates"), `${caseId}.json`);
  const imagesPath = dirOr(str("images"), "evals/local/images.json");
  const outputDir = dirOr(str("output-dir"), "evals/local/shortlists");
  const serviceDir = resolve(deps.repoRoot, "services/vision");
  const runner =
    deps.runner ??
    new PythonImageSimilarityRunner({
      python: str("python") ? fromCwd(str("python")!) : join(serviceDir, ".venv/bin/python"),
      serviceDir,
      onDiagnostic: (line) => io.err(`[vision] ${line}`),
    });

  try {
    let saved: SavedFingerprint;
    try {
      saved = await loadSavedFingerprint(recordPath, caseId);
    } catch (error) {
      if (error instanceof SavedRunError) {
        throw new InputProblem(error.problem === "missing_record" ? SHORTLIST_EXIT_USAGE : SHORTLIST_EXIT_INVALID, error.message);
      }
      throw error;
    }
    if (saved.fingerprint.source.dataSource === "mock" && !synthetic) {
      throw new InputProblem(SHORTLIST_EXIT_USAGE, `Run record ${display(recordPath)} is synthetic: pass --synthetic to use it`);
    }

    const loaded = await loadManifest(manifestPath, display(manifestPath));
    const problems = await checkManifest(loaded, saved, display(manifestPath), synthetic, { checkLocalFiles: false });
    if (problems.length > 0) {
      for (const p of problems) io.err(`Invalid: ${p}`);
      return SHORTLIST_EXIT_INVALID;
    }
    if (loaded.manifest.capture.status !== "completed") {
      throw new InputProblem(
        SHORTLIST_EXIT_USAGE,
        `Manifest ${display(manifestPath)} is not filled in yet (capture.status "not_started"). This is missing input, not an empty search result.`,
      );
    }
    const imported = importCuratedCandidates([loaded.manifest]);
    if (imported.dataSource === "mock" || saved.fingerprint.source.dataSource === "mock") {
      notice("SYNTHETIC: contains synthetic data; these are not real Alibaba.com listings.");
    }

    const reference = await resolveReferenceImage(imagesPath, saved);
    const plans = await planListingImages(imported.listings, dirname(manifestPath), caseId);
    const request = buildEmbedRequest(reference, plans, { id: modelId, revision }, device);

    if (dryRun) {
      const suppliers = new Map(imported.suppliers.map((s) => [s.id, s.name]));
      io.out(`# Shortlist dry run: ${caseId} (no model was loaded and nothing was downloaded)`);
      io.out(`Reference ${saved.reference.id}, fingerprint ${saved.fingerprint.id}: image found and SHA-256 matches the saved run (${reference.sha256}).`);
      io.out(`Manifest ${display(manifestPath)}: ${imported.listings.length} listing(s), ${imported.suppliers.length} supplier(s).`);
      io.out(`Model ${modelId}${revision ? ` @ ${revision}` : ""}; device requested: ${device}; top-K ${topK}.`);
      io.out(`Image selection: ${IMAGE_SELECTION_POLICY}`);
      for (const p of plans) {
        const first = p.images[0];
        io.out(`- ${p.listing.id}: ${p.listing.title}`);
        io.out(`    supplier: ${p.listing.supplierId ? (suppliers.get(p.listing.supplierId) ?? "unknown") : "not recorded"}`);
        io.out(
          first
            ? `    image: ${first.ref} (role ${first.role ?? "none"}, sha256 ${first.sha256.slice(0, 16)}…)${p.images.length > 1 ? `; ${p.images.length - 1} fallback image(s)` : ""}`
            : `    image: NONE USABLE — will be excluded${p.rejected.length ? ` (${p.rejected.map((r) => `${r.ref}: ${r.problem}`).join("; ")})` : " (no images recorded)"}`,
        );
      }
      io.out(`Would embed 1 reference and ${request.groups.length} candidate image(s).`);
      try {
        const env = await runner.environment({ id: modelId, revision });
        io.out(
          `Environment: Python ${env.runtime.python}, torch ${env.runtime.torch}, transformers ${env.runtime.transformers}; device auto → ${env.device.auto} (${env.device.reason}).`,
        );
        io.out(
          env.model.cached
            ? `Model cache: ${env.model.id} is cached at revision ${env.model.revision}.`
            : `Model cache: NOT READY — ${env.model.reason ?? "checkpoint not cached"}`,
        );
      } catch (error) {
        io.out(`Environment: NOT READY — ${(error as Error).message}`);
      }
      return SHORTLIST_EXIT_OK;
    }

    let response: EmbedOkResponse | null = null;
    if (request.groups.length > 0) {
      notice(`Embedding 1 reference and ${request.groups.length} candidate image(s) with ${modelId} (local model)…`);
      response = await runner.embed(request);
    }
    const shortlist = buildVisualShortlist({
      caseId,
      saved,
      imported,
      plans,
      response,
      topK,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
    });

    if (values["no-save"] !== true) {
      const base = join(outputDir, `${caseId}-${modelId.slice("google/".length)}`);
      await mkdir(outputDir, { recursive: true });
      await writeFile(`${base}.json`, `${JSON.stringify(shortlist, null, 2)}\n`);
      await writeFile(`${base}.md`, renderShortlistMarkdown(shortlist));
      notice(`Saved ${display(`${base}.json`)} and ${display(`${base}.md`)}.`);
    }
    io.out(json ? JSON.stringify(shortlist, null, 2) : renderShortlistText(shortlist));
    return SHORTLIST_EXIT_OK;
  } catch (error) {
    if (error instanceof InputProblem) {
      io.err(`Error: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof EvidenceError) {
      io.err(`Error: ${error.message}`);
      return SHORTLIST_EXIT_INVALID;
    }
    if (error instanceof EmbeddingServiceError || error instanceof EmbeddingProtocolError) {
      const code = error instanceof EmbeddingServiceError ? ` [${error.code}]` : "";
      io.err(`Error: embedding failed${code}: ${error.message}. No scores were produced.`);
      return SHORTLIST_EXIT_EMBEDDING;
    }
    throw error;
  }
}
