import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { candidateManifestSchema, type CandidateManifest } from "../discovery/curated/manifest";
import { acquireListingImages, type ImageOutcome } from "../discovery/images/acquire-images";
import { DEFAULT_IMAGE_FETCH_POLICY, safeFetchImage, type FetchedImage } from "../discovery/images/safe-image-fetch";
import {
  buildImageSearchInput,
  buildKeywordInput,
  LIMITS,
  planDiscovery,
  PRICING,
  PROVIDER_SOURCE_LABEL,
  type DiscoveryModeOption,
  type ImageTransport,
} from "../discovery/providers/apify/actor-input";
import { ApifyClient, ApifyError } from "../discovery/providers/apify/apify-client";
import {
  advanceRuns,
  createJournal,
  describeDiscoveryState,
  normalizeSavedRuns,
  type ApifyApi,
  type DiscoveryStateView,
  type FinalizedDiscovery,
} from "../discovery/providers/apify/discovery-run";
import { ProviderSchemaError } from "../discovery/providers/apify/normalize";
import { JournalError, loadJournal, saveJournal, writeJsonAtomic, type DiscoveryRunJournal } from "../discovery/providers/apify/run-journal";
import { inspectImage } from "../image-input/inspect";
import { EvidenceError, resolveReferenceImage } from "../shortlisting/evidence";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import type { CliIO } from "./analyze-image";

/**
 * Automated Alibaba.com candidate discovery through a configured provider
 * (Apify, Actor scrapewise/alibaba-com-scraper: a third-party scraper, not an
 * official Alibaba.com API). Safe by default: without --live nothing is sent.
 * Results are saved to a private run folder as a provider_api candidate
 * manifest that source:candidates, shortlist:images and verify:visual read.
 */

export const DISCOVER_EXIT_OK = 0;
export const DISCOVER_EXIT_INVALID = 1;
export const DISCOVER_EXIT_USAGE = 2;
/** The provider failed (or no run succeeded); never reported as zero results. */
export const DISCOVER_EXIT_PROVIDER = 3;
/** A provider run is still running or its start is uncertain: resume it, do not start another. */
export const DISCOVER_EXIT_PENDING = 5;

export interface DiscoverMarketplaceCliDeps {
  io: CliIO;
  cwd: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
  /** Only called for --live, --resume and --fetch-images. */
  createClient?: (token: string) => ApifyApi & Pick<ApifyClient, "createKeyValueStore" | "putRecord" | "deleteKeyValueStore" | "recordUrl">;
  fetchImage?: (url: string, allowedDomains: readonly string[]) => Promise<FetchedImage>;
  /** AVIF → PNG; defaults to services/vision when its environment exists. */
  convertAvif?: ((avifPath: string, sha256: string, pngPath: string) => Promise<void>) | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export const DISCOVER_USAGE = `Automated Alibaba.com candidate discovery via a configured provider (default: dry run, nothing sent).

Usage:
  pnpm discover:marketplace --case <id> --provider apify --mode image|keyword|hybrid [--dry-run]
  pnpm discover:marketplace --case <id> --provider apify --mode <m> --live --max-results <n> --max-provider-cost-usd <usd> --data-use-reviewed [image options]
  pnpm discover:marketplace --case <id> --resume <run folder> [--provider-run-id <id>]
  pnpm discover:marketplace --case <id> --replay <run folder> [--output-dir <dir>]     Offline re-normalization
  pnpm discover:marketplace --case <id> --fetch-images <run folder> --data-use-reviewed  Cache provider images

Live run requirements (all explicit):
  --live, --provider apify, --mode, --max-results (1-${LIMITS.maxResults}), --max-provider-cost-usd (≤ ${LIMITS.maxCostUsd}),
  --data-use-reviewed (you reviewed the provider's and Alibaba.com's terms for this use), APIFY_TOKEN.
  Image or hybrid mode also needs --authorize-image-upload and one transport:
    --image-transport url --image-url <https URL you already host>   (sent as imageUrls; checked against the reference hash first)
    --image-transport apify-storage                                   (uploaded to a temporary store in your Apify account, sent as imageFile; deleted afterwards)

Options:
  --max-queries <n>         Keyword queries from the saved fingerprint (default 2, max ${LIMITS.maxQueries})
  --download-images         After the search, cache provider image URLs locally (alicdn.com/alibaba.com only)
  --images-per-listing <n>  Images cached per listing (default 1, max 3)
  --wait-seconds <n>        How long to wait for runs before leaving them pending (default 300)
  --output-dir <dir>        Discovery folder (default evals/local/discovery); replay output folder with --replay
  --predictions <dir>, --record <file>, --images <file>   Saved run and image mapping locations
  --json                    Print the summary as JSON
  -h, --help                Show this help`;

class Problem extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function pythonConverter(repoRoot: string) {
  const serviceDir = join(repoRoot, "services/vision");
  const python = join(serviceDir, ".venv/bin/python");
  return (avifPath: string, sha256: string, pngPath: string) =>
    new Promise<void>((resolvePromise, reject) => {
      execFile(
        python,
        ["-m", "vfsa_vision", "convert", "--input", avifPath, "--sha256", sha256, "--output", pngPath],
        {
          cwd: serviceDir,
          timeout: 60_000,
          encoding: "utf8",
          // Only what Python needs; NodeJS.ProcessEnv is augmented by Next.js to require NODE_ENV.
          env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } as unknown as NodeJS.ProcessEnv,
        },
        (error: Error | null, stdout: string) => {
          if (!error) return resolvePromise();
          let message = "AVIF conversion failed";
          try {
            message = (JSON.parse(stdout) as { error?: { message?: string } }).error?.message ?? message;
          } catch {
            // keep the generic message
          }
          reject(new Error(message));
        },
      );
    });
}

interface Summary {
  discoveryId: string;
  provider: string;
  access: "third_party_service";
  mode: string;
  /** The journal's recorded status; see `state.meaning`. */
  status: DiscoveryRunJournal["status"];
  state: DiscoveryStateView;
  /** What produced this summary: a live/resume command, or an offline replay that does not change the journal. */
  processing: "provider_command" | "offline_replay";
  runs: {
    mode: string;
    state: string;
    providerRunId: string | null;
    rawRows: number | null;
    providerErrorRows: number;
    chargedUsd: number | null;
    chargedEvents: Record<string, number> | null;
    error: string | null;
  }[];
  /** Null when no provider run succeeded: a failed search has no result counts (it is not an empty result). */
  counts: {
    validProducts: number;
    uniqueListings: number;
    duplicatesMerged: number;
    suppliers: number;
    listingsWithoutLocalImage: number;
    listingsWithoutImageUrl: number;
    imagesCached: number;
    imagesFailed: number;
    rejectedRows: number;
  } | null;
  rejections: Record<string, number>;
  providerErrors: { mode: string; code: string; message: string }[];
  warnings: string[];
  manifest: string | null;
}

function summarize(
  journal: DiscoveryRunJournal,
  finalized: FinalizedDiscovery | null,
  manifest: CandidateManifest | null,
  images: ImageOutcome[] | null,
  manifestPath: string | null,
  processing: Summary["processing"] = "provider_command",
): Summary {
  const rejections: Record<string, number> = {};
  for (const r of finalized?.build.rejections ?? []) rejections[r.reason] = (rejections[r.reason] ?? 0) + 1;
  const candidates = manifest?.candidates ?? [];
  const warnings = [...new Set((finalized?.build.warnings ?? []).map((w) => w.warning))].map(
    (w) => `${w} (${finalized!.build.warnings.filter((x) => x.warning === w).length} listing(s))`,
  );
  return {
    discoveryId: journal.discoveryId,
    provider: PROVIDER_SOURCE_LABEL,
    access: "third_party_service",
    mode: journal.request.mode,
    status: journal.status,
    state: describeDiscoveryState(journal),
    processing,
    runs: journal.runs.map((r) => ({
      mode: r.mode,
      state: r.state,
      providerRunId: r.providerRunId,
      rawRows: r.itemCount,
      providerErrorRows: (finalized?.providerErrors ?? []).filter((e) => e.providerRunId === r.providerRunId).length,
      chargedUsd: r.usageTotalUsd,
      chargedEvents: r.chargedEventCounts,
      error: r.error ? `${r.error.category}: ${r.error.message}` : r.statusMessage && r.state !== "succeeded" ? r.statusMessage : null,
    })),
    counts: !finalized
      ? null
      : {
      validProducts: (finalized?.normalized ?? []).reduce((a, n) => a + n.candidates.length, 0),
      uniqueListings: candidates.length,
      duplicatesMerged: finalized?.build.duplicatesMerged ?? 0,
      suppliers: manifest?.suppliers.length ?? 0,
      listingsWithoutLocalImage: candidates.filter((c) => !c.images.some((i) => "localPath" in i)).length,
      listingsWithoutImageUrl: candidates.filter((c) => !c.images.some((i) => "url" in i)).length,
      imagesCached: (images ?? []).filter((o) => o.status === "cached" || o.status === "reused").length,
      imagesFailed: (images ?? []).filter((o) => o.status === "failed").length,
      rejectedRows: finalized?.build.rejections.length ?? 0,
        },
    rejections,
    providerErrors: (finalized?.providerErrors ?? []).map((e) => ({ mode: e.mode, code: e.code, message: e.message })),
    warnings,
    manifest: manifestPath,
  };
}

function renderSummary(s: Summary): string[] {
  const lines = [
    s.processing === "offline_replay"
      ? `# Offline replay of discovery ${s.discoveryId} (no provider request; the run folder is not changed)`
      : `# Discovery ${s.discoveryId}`,
    `Recorded journal status: ${s.status} — ${s.state.meaning}.`,
    `Provider runs: ${s.state.providerRuns.succeeded} succeeded, ${s.state.providerRuns.failed} failed, ${s.state.providerRuns.pending} pending, ${s.state.providerRuns.notStarted} not started; saved snapshots ${s.state.snapshotsAvailable}. External provider work pending: ${s.state.externalWorkPending ? "YES (resume)" : "no"}.`,
    `Provider ${s.provider} (third-party scraper on Apify, not an official Alibaba.com API); mode ${s.mode}.`,
  ];
  for (const r of s.runs) {
    lines.push(
      `- ${r.mode} run ${r.providerRunId ?? "(not started)"}: ${r.state}; rows ${r.rawRows ?? "—"}; provider error rows ${r.providerErrorRows}; charged ${r.chargedUsd === null ? "not reported" : `$${r.chargedUsd}`}${r.error ? `; ${r.error}` : ""}`,
    );
  }
  const c = s.counts;
  if (!c) {
    lines.push(
      s.status === "pending_provider"
        ? "No results yet: a provider run has not finished."
        : "No results: no provider run succeeded. This is a failed search, not an empty result.",
    );
    return lines;
  }
  lines.push(
    `Valid products ${c.validProducts}; unique listings ${c.uniqueListings} (duplicates merged ${c.duplicatesMerged}); suppliers ${c.suppliers}.`,
    `Rejected rows ${c.rejectedRows}${Object.keys(s.rejections).length ? ` (${Object.entries(s.rejections).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}.`,
    `Images cached ${c.imagesCached}; failed ${c.imagesFailed}; listings without a local image ${c.listingsWithoutLocalImage}; without any image URL ${c.listingsWithoutImageUrl}.`,
  );
  for (const e of s.providerErrors.slice(0, 5)) lines.push(`Provider error row (${e.mode}): ${e.code}: ${e.message}`);
  for (const w of s.warnings) lines.push(`Warning: ${w}`);
  if (s.manifest) lines.push(`Manifest: ${s.manifest}`);
  return lines;
}

export async function runDiscoverMarketplaceCli(argv: string[], deps: DiscoverMarketplaceCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        case: { type: "string" },
        provider: { type: "string" },
        mode: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        resume: { type: "string" },
        replay: { type: "string" },
        "fetch-images": { type: "string" },
        "max-results": { type: "string" },
        "max-provider-cost-usd": { type: "string" },
        "max-queries": { type: "string" },
        "data-use-reviewed": { type: "boolean", default: false },
        "authorize-image-upload": { type: "boolean", default: false },
        "image-transport": { type: "string" },
        "image-url": { type: "string" },
        "download-images": { type: "boolean", default: false },
        "images-per-listing": { type: "string" },
        "wait-seconds": { type: "string" },
        "provider-run-id": { type: "string" },
        "output-dir": { type: "string" },
        predictions: { type: "string" },
        record: { type: "string" },
        images: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(DISCOVER_USAGE);
    return DISCOVER_EXIT_USAGE;
  }
  if (values.help) {
    io.out(DISCOVER_USAGE);
    return DISCOVER_EXIT_OK;
  }
  const usage = (message: string) => {
    io.err(`Error: ${message}`);
    io.err(DISCOVER_USAGE);
    return DISCOVER_EXIT_USAGE;
  };
  const str = (k: string) => values[k] as string | undefined;
  const flag = (k: string) => values[k] === true;
  const int = (k: string, min: number, max: number, fallback?: number): number | string | undefined => {
    const raw = str(k);
    if (raw === undefined) return fallback;
    return /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : `--${k} must be a whole number from ${min} to ${max}`;
  };

  const caseId = str("case");
  if (!caseId || !/^[a-z0-9][a-z0-9-]*$/.test(caseId)) return usage("--case <id> is required (lower-case letters, digits, hyphens)");
  const actions = (["dry-run", "live"] as const).filter(flag).map(String).concat((["resume", "replay", "fetch-images"] as const).filter((k) => str(k) !== undefined));
  if (actions.length > 1) return usage("choose one of --dry-run, --live, --resume, --replay or --fetch-images");
  const action = actions[0] ?? "dry-run";
  const now = () => deps.now?.() ?? new Date();
  const json = flag("json");

  const fromCwd = (p: string) => resolve(deps.cwd, p);
  const dirOr = (value: string | undefined, fallback: string) => (value ? fromCwd(value) : resolve(deps.repoRoot, fallback));
  const display = (p: string) => {
    const rel = relative(deps.repoRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const recordPath = str("record") ? fromCwd(str("record")!) : join(dirOr(str("predictions"), "evals/local/predictions"), `${caseId}.json`);
  const imagesMap = dirOr(str("images"), "evals/local/images.json");
  const discoveryRoot = dirOr(action === "replay" ? undefined : str("output-dir"), "evals/local/discovery");
  const token = deps.env.APIFY_TOKEN?.trim() || undefined;
  const client = () => {
    if (!token) throw new Problem(DISCOVER_EXIT_USAGE, "APIFY_TOKEN is not set. Add it to apps/web/.env.local (see .env.example).");
    return deps.createClient ? deps.createClient(token) : new ApifyClient({ token });
  };
  const fetchImage = deps.fetchImage ?? ((url: string, allowedDomains: readonly string[]) => safeFetchImage(url, { ...DEFAULT_IMAGE_FETCH_POLICY, allowedDomains }));
  const convertAvif = deps.convertAvif !== undefined ? deps.convertAvif : pythonConverter(deps.repoRoot);

  const loadSaved = async (): Promise<SavedFingerprint> => {
    try {
      const saved = await loadSavedFingerprint(recordPath, caseId);
      if (saved.fingerprint.source.dataSource === "mock" && (action === "live" || action === "dry-run")) {
        throw new Problem(DISCOVER_EXIT_USAGE, "The saved run is synthetic; live discovery needs a genuine fingerprint");
      }
      return saved;
    } catch (error) {
      if (error instanceof SavedRunError) throw new Problem(error.problem === "missing_record" ? DISCOVER_EXIT_USAGE : DISCOVER_EXIT_INVALID, error.message);
      throw error;
    }
  };
  /** Resume and fetch-images only touch run folders inside <discovery root>/<case>/; replay only reads. */
  const runFolder = (value: string) => {
    const dir = fromCwd(value);
    const rel = relative(join(discoveryRoot, caseId), dir);
    if (action !== "replay" && (rel.startsWith("..") || isAbsolute(rel) || rel === "")) {
      throw new Problem(DISCOVER_EXIT_USAGE, `The run folder must be inside ${display(join(discoveryRoot, caseId))}/`);
    }
    return dir;
  };

  const finalize = async (saved: SavedFingerprint, runDir: string, journal: DiscoveryRunJournal, download: boolean): Promise<number> => {
    const outputs: { finalized: FinalizedDiscovery | null; manifest: CandidateManifest | null; images: ImageOutcome[] | null; path: string | null } = {
      finalized: null,
      manifest: null,
      images: null,
      path: null,
    };
    if (journal.status === "in_progress") {
      outputs.finalized = await normalizeSavedRuns(runDir, journal, saved);
      let manifest = outputs.finalized.build.manifest;
      if (download) {
        const acquired = await acquireListingImages(manifest, {
          runDir,
          caseId,
          imagesPerListing: journal.request.imagesPerListing,
          maxImages: journal.request.maxResults * journal.request.imagesPerListing,
          fetchImage: (url) => fetchImage(url, DEFAULT_IMAGE_FETCH_POLICY.allowedDomains),
          convertAvif,
        });
        manifest = candidateManifestSchema.parse(acquired.manifest);
        outputs.images = acquired.outcomes;
        await writeJsonAtomic(join(runDir, "images.json"), { recordType: "discovery_image_evidence", schemaVersion: 1, outcomes: acquired.outcomes });
      }
      outputs.manifest = manifest;
      outputs.path = join(runDir, `${caseId}.json`);
      await writeJsonAtomic(outputs.path, manifest);
      journal.manifestFile = `${caseId}.json`;
      // A manifest exists; any failed or unstarted run is reported in the summary and the exit code.
      journal.status = "completed";
    }
    const summary = summarize(journal, outputs.finalized, outputs.manifest, outputs.images, outputs.path ? display(outputs.path) : null);
    await writeJsonAtomic(join(runDir, "import-summary.json"), summary);
    journal.summaryFile = "import-summary.json";
    journal.updatedAt = now().toISOString();
    await saveJournal(runDir, journal);
    if (json) io.out(JSON.stringify(summary, null, 2));
    else renderSummary(summary).forEach((l) => io.out(l));
    if (journal.status === "pending_provider") {
      io.out(`A provider run is still running or its start is uncertain. Do not start a new search; resume with:`);
      io.out(`  pnpm discover:marketplace --case ${caseId} --resume ${display(runDir)}`);
      return DISCOVER_EXIT_PENDING;
    }
    if (outputs.manifest && journal.runs.some((r) => r.state !== "succeeded")) {
      io.out("Partial result: not every provider run succeeded (see above). The manifest holds only the successful runs.");
    }
    if (outputs.manifest) {
      io.out("Next (offline):");
      io.out(`  pnpm source:candidates --case ${caseId} --candidates ${display(runDir)} --validate`);
      io.out(`  pnpm shortlist:images --case ${caseId} --candidates ${display(runDir)} --dry-run`);
    }
    return journal.runs.every((r) => r.state === "succeeded") ? DISCOVER_EXIT_OK : DISCOVER_EXIT_PROVIDER;
  };

  const cleanupStorage = async (api: ReturnType<typeof client>, journal: DiscoveryRunJournal, runDir: string) => {
    const upload = journal.storageUpload;
    if (!upload || upload.deletedAt) return;
    if (journal.runs.some((r) => r.state === "running" || r.state === "start_requested" || r.state === "start_uncertain")) return;
    try {
      await api.deleteKeyValueStore(upload.storeId);
      upload.deletedAt = now().toISOString();
      upload.deleteError = null;
    } catch (error) {
      upload.deleteError = (error as Error).message;
      io.err(`Warning: could not delete the temporary Apify store ${upload.storeId}; delete it in the Apify console.`);
    }
    await saveJournal(runDir, journal);
  };

  try {
    if (action === "replay" || action === "resume" || action === "fetch-images") {
      const runDir = runFolder(str(action)!);
      const journal = await loadJournal(runDir);
      if (journal.caseId !== caseId) throw new Problem(DISCOVER_EXIT_INVALID, `That run belongs to case "${journal.caseId}"`);
      const saved = await loadSaved();
      if (journal.reference.fingerprintId !== saved.fingerprint.id || journal.reference.sha256 !== saved.record.image.sha256) {
        throw new Problem(DISCOVER_EXIT_INVALID, "That run was made from a different fingerprint or reference image");
      }

      if (action === "replay") {
        // Offline: re-validate and re-normalize saved provider rows. No network.
        const finalized = await normalizeSavedRuns(runDir, journal, saved);
        const summary = summarize(journal, finalized, finalized.build.manifest, null, null, "offline_replay");
        if (str("output-dir")) {
          const out = fromCwd(str("output-dir")!);
          if (resolve(out) === resolve(runDir)) throw new Problem(DISCOVER_EXIT_USAGE, "--output-dir must differ from the run folder (replay never overwrites it)");
          const path = join(out, `${caseId}.json`);
          await writeJsonAtomic(path, finalized.build.manifest);
          await writeJsonAtomic(join(out, "replay-summary.json"), { ...summary, manifest: display(path) });
          summary.manifest = display(path);
        }
        if (json) io.out(JSON.stringify(summary, null, 2));
        else renderSummary(summary).forEach((l) => io.out(l));
        return DISCOVER_EXIT_OK;
      }

      if (action === "fetch-images") {
        if (!flag("data-use-reviewed")) return usage("--fetch-images needs --data-use-reviewed (image retrieval must be permitted for this use)");
        if (!journal.manifestFile) throw new Problem(DISCOVER_EXIT_USAGE, "That run has no manifest yet");
        const manifestPath = join(runDir, journal.manifestFile);
        const manifest = candidateManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        const perListing = int("images-per-listing", 1, 3, journal.request.imagesPerListing);
        if (typeof perListing === "string") return usage(perListing);
        const acquired = await acquireListingImages(manifest, {
          runDir,
          caseId,
          imagesPerListing: perListing!,
          maxImages: manifest.candidates.length * perListing!,
          fetchImage: (url) => fetchImage(url, DEFAULT_IMAGE_FETCH_POLICY.allowedDomains),
          convertAvif,
        });
        await writeJsonAtomic(manifestPath, candidateManifestSchema.parse(acquired.manifest));
        await writeJsonAtomic(join(runDir, "images.json"), { recordType: "discovery_image_evidence", schemaVersion: 1, outcomes: acquired.outcomes });
        const cached = acquired.outcomes.filter((o) => o.status === "cached" || o.status === "reused").length;
        io.out(`Images cached ${cached}; failed ${acquired.outcomes.filter((o) => o.status === "failed").length}. Manifest updated: ${display(manifestPath)}`);
        return DISCOVER_EXIT_OK;
      }

      // Resume: never starts a run; reconciles and finishes existing ones.
      const api = client();
      const uncertain = journal.runs.filter((r) => r.state === "start_uncertain" || (r.state === "start_requested" && !r.providerRunId));
      if (uncertain.length) {
        const id = str("provider-run-id");
        if (!id || uncertain.length > 1) {
          const recent = await api.listRecentRuns("scrapewise/alibaba-com-scraper", 10);
          const since = Date.parse(uncertain[0].startRequestedAt ?? journal.createdAt) - 60_000;
          io.out(`The ${uncertain[0].mode} run's start is uncertain (it may or may not have been created). Recent runs of the Actor in your account:`);
          for (const r of recent.filter((x) => !x.startedAt || Date.parse(x.startedAt) >= since)) io.out(`  ${r.id}  ${r.status}  started ${r.startedAt ?? "?"}`);
          io.out("If one of them is this search, attach it with --provider-run-id <id>. No new run is started automatically.");
          return DISCOVER_EXIT_PENDING;
        }
        const run = await api.getRun(id);
        Object.assign(uncertain[0], { state: "running", providerRunId: run.id, datasetId: run.datasetId, error: null });
      }
      const wait = int("wait-seconds", 10, 900, 300);
      if (typeof wait === "string") return usage(wait);
      await advanceRuns({ client: api, runDir, now, waitSeconds: wait!, sleep: deps.sleep }, journal, { startPlanned: false });
      await cleanupStorage(api, journal, runDir);
      return await finalize(saved, runDir, journal, journal.request.downloadImages);
    }

    // Dry run and live.
    if (str("provider") !== "apify") return usage("--provider apify is required (the only configured provider)");
    const mode = str("mode") as DiscoveryModeOption | undefined;
    if (!mode || !["image", "keyword", "hybrid"].includes(mode)) return usage("--mode image|keyword|hybrid is required");
    const maxQueries = int("max-queries", 1, LIMITS.maxQueries, 2);
    const perListing = int("images-per-listing", 1, 3, 1);
    const wait = int("wait-seconds", 10, 900, 300);
    for (const v of [maxQueries, perListing, wait]) if (typeof v === "string") return usage(v);
    const maxResultsRaw = int("max-results", 1, LIMITS.maxResults);
    if (typeof maxResultsRaw === "string") return usage(maxResultsRaw);
    const costRaw = str("max-provider-cost-usd");
    const cost = costRaw === undefined ? undefined : Number(costRaw);
    if (costRaw !== undefined && !(/^\d+(\.\d+)?$/.test(costRaw) && cost! > 0 && cost! <= LIMITS.maxCostUsd)) {
      return usage(`--max-provider-cost-usd must be a number above 0 and at most ${LIMITS.maxCostUsd}`);
    }
    const transportKind = str("image-transport");
    if (transportKind !== undefined && !["url", "apify-storage"].includes(transportKind)) return usage("--image-transport must be url or apify-storage");
    if (transportKind === "url" && !str("image-url")) return usage("--image-transport url needs --image-url <https URL>");
    if (str("image-url") && transportKind !== "url") return usage("--image-url requires --image-transport url");
    const needsImage = mode !== "keyword";

    const saved = await loadSaved();
    const reference = await resolveReferenceImage(imagesMap, saved);
    const referenceBytes = new Uint8Array(await readFile(reference.path));
    const referenceInfo = inspectImage(referenceBytes);
    const maxResults = (maxResultsRaw as number | undefined) ?? 10;
    const costCap = cost ?? 1;
    const plan = planDiscovery({ mode, maxResults, fingerprintQueries: saved.fingerprint.searchQueries, maxQueries: maxQueries as number, costCapUsd: costCap });

    if (action === "dry-run") {
      const lines = [
        `# Discovery dry run: ${caseId} (no provider request was made)`,
        `Reference ${saved.reference.id}: ${referenceInfo.mimeType} ${referenceInfo.width}x${referenceInfo.height}, ${referenceBytes.length} bytes, sha256 ${reference.sha256} (matches the saved run)`,
        `Fingerprint ${saved.fingerprint.id} (${saved.fingerprint.source.modelId ?? saved.fingerprint.source.kind}); category ${saved.fingerprint.category}`,
        `Provider: ${PROVIDER_SOURCE_LABEL} — a third-party scraper on Apify, NOT an official Alibaba.com API. Live use needs your review of its terms and Alibaba.com's (--data-use-reviewed).`,
        `Mode ${mode}; ${plan.runs.length} provider run(s); max results ${maxResults}${maxResultsRaw === undefined ? " (default for planning; --live requires --max-results)" : ""}.`,
      ];
      for (const r of plan.runs) {
        const preview =
          r.mode === "image"
            ? buildImageSearchInput({ kind: transportKind === "url" ? "url" : "apify_storage", url: "<reference image link>" }, r.maxResults)
            : buildKeywordInput(r.queries, r.maxResults);
        lines.push(`- ${r.mode} run: worst-case charge $${r.estimatedUsd} (published prices ${PRICING.checkedAt}); cap share $${r.costCapUsd}`);
        lines.push(`    Actor input: ${JSON.stringify(preview)}`);
        if (r.mode === "keyword") lines.push(`    Queries (saved Luna queries, unchanged): ${r.queries.map((q) => `"${q}"`).join(", ")}`);
      }
      lines.push(`Cost cap: $${costCap}${cost === undefined ? " (default for planning; --live requires --max-provider-cost-usd)" : ""}; estimate $${plan.estimatedUsd}.`);
      for (const p of plan.problems) lines.push(`PROBLEM: ${p}`);
      lines.push(`APIFY_TOKEN: ${token ? "set" : "NOT SET (required for --live)"}`);
      lines.push(
        needsImage
          ? `Image submission: ${transportKind === "url" ? `user-hosted URL ${str("image-url")} (sent as imageUrls; its bytes are checked against the reference hash before the run)` : transportKind === "apify-storage" ? "temporary upload to your own Apify storage, sent as imageFile (UNVERIFIED with this Actor: its imageFile handling is undocumented); deleted after the run" : "NOT CONFIGURED (choose --image-transport url --image-url <https URL> or --image-transport apify-storage)"}; requires --authorize-image-upload`
          : "Image submission: not used (keyword mode)",
      );
      lines.push(
        `Image download: ${flag("download-images") ? `on — up to ${perListing} image(s) per listing from alicdn.com/alibaba.com over HTTPS, size/time limited, private addresses refused` : "off (add --download-images, or run --fetch-images later)"}`,
      );
      lines.push(`Output: ${display(join(discoveryRoot, caseId))}/<discovery id>/ (run.json, provider snapshots, ${caseId}.json manifest, images, import-summary.json)`);
      lines.forEach((l) => io.out(l));
      return DISCOVER_EXIT_OK;
    }

    // Live: every authorization explicit.
    if (maxResultsRaw === undefined) return usage("--live requires --max-results <n>");
    if (cost === undefined) return usage("--live requires --max-provider-cost-usd <usd>");
    if (!flag("data-use-reviewed")) return usage("--live requires --data-use-reviewed: review the provider's terms and Alibaba.com's restrictions first (docs/automated-marketplace-discovery.md)");
    if (needsImage && !flag("authorize-image-upload")) return usage("image search sends your reference photo to the provider: add --authorize-image-upload to allow it");
    if (needsImage && !transportKind) return usage("image search needs --image-transport url|apify-storage");
    if (plan.problems.length) return usage(plan.problems.join("; "));
    const api = client();

    const createdAt = now();
    const { journal } = createJournal({
      caseId,
      saved,
      mode,
      maxResults,
      costCapUsd: costCap,
      maxQueries: maxQueries as number,
      imageTransport: null,
      downloadImages: flag("download-images"),
      imagesPerListing: perListing as number,
      now: createdAt,
    });
    const runDir = join(discoveryRoot, caseId, journal.discoveryId);
    await saveJournal(runDir, journal);
    io.out(`Discovery ${journal.discoveryId} → ${display(runDir)}`);

    if (needsImage) {
      let transport: ImageTransport;
      if (transportKind === "url") {
        const url = new URL(str("image-url")!);
        // The provider fetches this URL; make sure it serves exactly the reference photo first.
        const served = await fetchImage(url.toString(), [url.hostname.toLowerCase()]);
        if (createHash("sha256").update(served.bytes).digest("hex") !== reference.sha256) {
          throw new Problem(DISCOVER_EXIT_INVALID, "The --image-url does not serve the reference photograph (SHA-256 differs). Nothing was sent to the provider.");
        }
        transport = { kind: "url", url: url.toString() };
      } else {
        const store = await api.createKeyValueStore();
        const key = `reference-${reference.sha256.slice(0, 16)}`;
        journal.storageUpload = { storeId: store.id, key, deletedAt: null, deleteError: null };
        await saveJournal(runDir, journal);
        await api.putRecord(store.id, key, referenceBytes, referenceInfo.mimeType);
        transport = { kind: "apify_storage", url: api.recordUrl(store.id, key) };
      }
      journal.request.imageTransport = transport;
      await saveJournal(runDir, journal);
    }

    await advanceRuns({ client: api, runDir, now, waitSeconds: wait as number, sleep: deps.sleep, log: (l) => io.out(l) }, journal, { startPlanned: true });
    await cleanupStorage(api, journal, runDir);
    return await finalize(saved, runDir, journal, flag("download-images"));
  } catch (error) {
    if (error instanceof Problem) {
      io.err(`Error: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof EvidenceError || error instanceof JournalError) {
      io.err(`Error: ${error.message}`);
      return DISCOVER_EXIT_INVALID;
    }
    if (error instanceof ProviderSchemaError) {
      io.err(`Error: ${error.message}. The rows are kept in the run folder; this is not an empty result.`);
      return DISCOVER_EXIT_PROVIDER;
    }
    if (error instanceof ApifyError) {
      io.err(`Error: provider request failed (${error.category}): ${error.message}. This is not an empty result.`);
      return DISCOVER_EXIT_PROVIDER;
    }
    throw error;
  }
}
