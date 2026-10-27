import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { importCuratedCandidates } from "../discovery/curated/curated-alibaba-adapter";
import type { CandidateListing } from "../domain";
import { EvidenceError, planListingImages, resolveReferenceImage } from "../shortlisting/evidence";
import { loadSavedShortlist, ShortlistFileError, type SavedShortlist } from "../shortlisting/shortlist-schema";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { LocalVerificationEvidence, type EvidenceImage } from "../verification/openai/evidence";
import { VISUAL_VERIFICATION_INSTRUCTIONS_VERSION } from "../verification/openai/instructions";
import {
  OpenAIVisualVerificationService,
  PaidRequestBudget,
  type PairOutcome,
} from "../verification/openai/openai-visual-verification";
import {
  finalRecord,
  loadVerificationRecords,
  pendingRecord,
  recordKey,
  verificationKey,
  writeFinalRecord,
  writePendingRecord,
  type RecordContext,
} from "../verification/openai/record";
import { buildVerificationReport, renderVerificationReportMarkdown } from "../verification/openai/report";
import {
  DEFAULT_VERIFICATION_REQUEST_SETTINGS,
  DEFAULT_VISUAL_VERIFICATION_MODEL,
  OpenAIVisualVerificationClient,
  type VerificationRequestSettings,
  type VisualVerificationModelClient,
} from "../verification/openai/verification-client";
import type { CliIO } from "./analyze-image";
import { checkManifest, InputProblem, loadManifest } from "./source-candidates";

/**
 * Detailed visual verification of recorded Alibaba.com candidates with
 * GPT-6.1 Sol. Safe by default: without --live it sends nothing. Paid runs
 * need --live, an explicit candidate selection and --max-paid-requests; each
 * pair is one request, with no retries and no fallback model. --report reads
 * saved records only.
 */

export const VERIFY_EXIT_OK = 0;
/** Invalid input, records or evidence. */
export const VERIFY_EXIT_INVALID = 1;
/** Usage error or missing input. */
export const VERIFY_EXIT_USAGE = 2;
/** At least one paid request did not produce a valid assessment. */
export const VERIFY_EXIT_REQUEST_FAILED = 3;
/** A result could not be saved (it was printed to stderr instead). */
export const VERIFY_EXIT_PERSISTENCE = 4;

const DEFAULT_SHORTLIST = (caseId: string) => `evals/local/shortlists/${caseId}-siglip2-base-patch16-384.json`;

export type VerificationClientFactory = (
  apiKey: string,
  model: string,
  settings: Omit<VerificationRequestSettings, "model">,
) => VisualVerificationModelClient;

export interface VerifyVisualCliDeps {
  io: CliIO;
  cwd: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
  /** Only called for --live runs with an API key. */
  createClient?: VerificationClientFactory;
  now?: () => Date;
}

export const VERIFY_USAGE = `Detailed visual verification of recorded candidates with ${DEFAULT_VISUAL_VERIFICATION_MODEL}.

Usage:
  pnpm verify:visual --case <id> [--dry-run]                       Plan only; sends nothing (default)
  pnpm verify:visual --case <id> --listing-id <id> --live --max-paid-requests 1
  pnpm verify:visual --case <id> --all --live --max-paid-requests <n>
  pnpm verify:visual --case <id> --report                          Offline comparison from saved records

Selection and paid-request controls:
  --listing-id <id>         One listing (e.g. alibaba-product-1601706922584)
  --all                     Every listing in the manifest, in manifest order
  --live                    Send paid requests (one per pair; never retried)
  --max-paid-requests <n>   Required with --live; at most the number of selected listings
  --rerun                   Request again even if a record for the same pair, images, model
                            and instructions already exists (otherwise those are skipped)

Other options:
  --model <id>              Default ${DEFAULT_VISUAL_VERIFICATION_MODEL} (or OPENAI_VISUAL_VERIFICATION_MODEL); never switched automatically
  --max-output-tokens <n>   Default ${DEFAULT_VERIFICATION_REQUEST_SETTINGS.maxOutputTokens} (includes reasoning)
  --timeout-ms <n>          Default ${DEFAULT_VERIFICATION_REQUEST_SETTINGS.timeoutMs}
  --output-dir <dir>        Records and reports (default evals/local/verifications)
  --shortlist <file>        Saved shortlist for the report (default ${DEFAULT_SHORTLIST("<case>")} if present)
  --predictions <dir>, --record <file>, --candidates <dir>, --manifest <file>, --images <file>
                            Input locations, as for shortlist:images
  --synthetic               Allow synthetic run records and manifests
  --json                    Print JSON
  -h, --help                Show this help

Environment: OPENAI_API_KEY (required for --live; read from apps/web/.env.local, never printed).`;

/** A record could not be created before a request; the request was not sent. */
class PendingRecordError extends Error {}

interface Plan {
  listing: CandidateListing;
  candidate: EvidenceImage | null;
  unusable: string[];
  existing: { status: string; file: string } | null;
  action: "request" | "skip_existing" | "skip_no_image";
}

export async function runVerifyVisualCli(argv: string[], deps: VerifyVisualCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: {
        case: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        report: { type: "boolean", default: false },
        "listing-id": { type: "string" },
        all: { type: "boolean", default: false },
        "max-paid-requests": { type: "string" },
        rerun: { type: "boolean", default: false },
        model: { type: "string" },
        "max-output-tokens": { type: "string" },
        "timeout-ms": { type: "string" },
        "output-dir": { type: "string" },
        shortlist: { type: "string" },
        predictions: { type: "string" },
        record: { type: "string" },
        candidates: { type: "string" },
        manifest: { type: "string" },
        images: { type: "string" },
        synthetic: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(VERIFY_USAGE);
    return VERIFY_EXIT_USAGE;
  }
  if (values.help) {
    io.out(VERIFY_USAGE);
    return VERIFY_EXIT_OK;
  }
  const usage = (message: string) => {
    io.err(`Error: ${message}`);
    io.err(VERIFY_USAGE);
    return VERIFY_EXIT_USAGE;
  };
  const str = (key: string) => values[key] as string | undefined;
  const flag = (key: string) => values[key] === true;
  const caseId = str("case");
  if (!caseId || !/^[a-z0-9][a-z0-9-]*$/.test(caseId)) return usage("--case <id> is required (lower-case letters, digits, hyphens)");
  const modes = (["dry-run", "live", "report"] as const).filter(flag);
  if (modes.length > 1) return usage("choose at most one of --dry-run, --live or --report");
  const mode = modes[0] ?? "dry-run";
  const listingId = str("listing-id");
  if (listingId !== undefined && flag("all")) return usage("use either --listing-id or --all, not both");
  if (mode === "report" && (listingId || flag("all") || flag("rerun") || str("max-paid-requests"))) {
    return usage("--report takes no selection or paid-request options");
  }
  if (mode === "live" && !listingId && !flag("all")) return usage("--live needs an explicit selection: --listing-id <id> or --all");
  let cap: number | undefined;
  if (str("max-paid-requests") !== undefined) {
    if (mode !== "live") return usage("--max-paid-requests only applies to --live");
    if (!/^[1-9]\d*$/.test(str("max-paid-requests")!)) return usage("--max-paid-requests must be a positive whole number");
    cap = Number(str("max-paid-requests"));
  } else if (mode === "live") {
    return usage("--live requires --max-paid-requests <n>; there is no default cap");
  }
  const intOption = (key: string, min: number, max: number, fallback: number): number | string => {
    const raw = str(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return /^\d+$/.test(raw) && n >= min && n <= max ? n : `--${key} must be a whole number from ${min} to ${max}`;
  };
  const maxOutputTokens = intOption("max-output-tokens", 1000, 32000, DEFAULT_VERIFICATION_REQUEST_SETTINGS.maxOutputTokens);
  if (typeof maxOutputTokens === "string") return usage(maxOutputTokens);
  const timeoutMs = intOption("timeout-ms", 10_000, 600_000, DEFAULT_VERIFICATION_REQUEST_SETTINGS.timeoutMs);
  if (typeof timeoutMs === "string") return usage(timeoutMs);
  const model = str("model") ?? (deps.env.OPENAI_VISUAL_VERIFICATION_MODEL?.trim() || DEFAULT_VISUAL_VERIFICATION_MODEL);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) return usage("--model has an invalid format");
  const settings: VerificationRequestSettings = { ...DEFAULT_VERIFICATION_REQUEST_SETTINGS, model, maxOutputTokens, timeoutMs };
  const synthetic = flag("synthetic");
  const json = flag("json");
  const notice = json ? io.err : io.out;
  const now = () => deps.now?.() ?? new Date();

  const fromCwd = (p: string) => resolve(deps.cwd, p);
  const dirOr = (value: string | undefined, fallback: string) => (value ? fromCwd(value) : resolve(deps.repoRoot, fallback));
  const display = (p: string) => {
    const rel = relative(deps.repoRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  };
  const recordPath = str("record") ? fromCwd(str("record")!) : join(dirOr(str("predictions"), "evals/local/predictions"), `${caseId}.json`);
  const manifestPath = str("manifest") ? fromCwd(str("manifest")!) : join(dirOr(str("candidates"), "evals/local/candidates"), `${caseId}.json`);
  const imagesPath = dirOr(str("images"), "evals/local/images.json");
  const outputDir = dirOr(str("output-dir"), "evals/local/verifications");
  const shortlistPath = str("shortlist") ? fromCwd(str("shortlist")!) : resolve(deps.repoRoot, DEFAULT_SHORTLIST(caseId));

  try {
    // Shared input validation (all modes).
    let saved: SavedFingerprint;
    try {
      saved = await loadSavedFingerprint(recordPath, caseId);
    } catch (error) {
      if (error instanceof SavedRunError) {
        throw new InputProblem(error.problem === "missing_record" ? VERIFY_EXIT_USAGE : VERIFY_EXIT_INVALID, error.message);
      }
      throw error;
    }
    if (saved.fingerprint.source.dataSource === "mock" && !synthetic) {
      throw new InputProblem(VERIFY_EXIT_USAGE, `Run record ${display(recordPath)} is synthetic: pass --synthetic to use it`);
    }
    const loaded = await loadManifest(manifestPath, display(manifestPath));
    const problems = await checkManifest(loaded, saved, display(manifestPath), synthetic, { checkLocalFiles: false });
    if (problems.length > 0) {
      for (const p of problems) io.err(`Invalid: ${p}`);
      return VERIFY_EXIT_INVALID;
    }
    if (loaded.manifest.capture.status !== "completed") {
      throw new InputProblem(VERIFY_EXIT_USAGE, `Manifest ${display(manifestPath)} is not filled in yet (capture.status "not_started").`);
    }
    const imported = importCuratedCandidates([loaded.manifest]);
    const isSynthetic = imported.dataSource === "mock" || saved.fingerprint.source.dataSource === "mock";
    if (isSynthetic) notice("SYNTHETIC: contains synthetic data; these are not real Alibaba.com listings.");

    let shortlist: SavedShortlist | null = null;
    try {
      shortlist = await loadSavedShortlist(shortlistPath, display(shortlistPath));
    } catch (error) {
      if (!(error instanceof ShortlistFileError)) throw error;
      if (!error.missing) throw new InputProblem(VERIFY_EXIT_INVALID, error.message);
      if (str("shortlist")) throw new InputProblem(VERIFY_EXIT_USAGE, error.message);
    }
    if (shortlist) {
      const ref = shortlist.reference;
      if (shortlist.caseId !== caseId || ref.referenceImageId !== saved.reference.id || ref.fingerprintId !== saved.fingerprint.id || ref.sha256 !== saved.record.image.sha256) {
        throw new InputProblem(VERIFY_EXIT_INVALID, `Shortlist ${display(shortlistPath)} belongs to a different case, reference, fingerprint or image`);
      }
      const known = new Set(imported.listings.map((l) => l.id));
      const unknown = [...shortlist.shortlist.map((e) => e.listingId), ...shortlist.belowTopK].find((id) => !known.has(id));
      if (unknown) throw new InputProblem(VERIFY_EXIT_INVALID, `Shortlist ${display(shortlistPath)} lists "${unknown}", which is not in the manifest`);
    }

    const existing = await loadVerificationRecords(outputDir, caseId);
    for (const p of existing.problems) io.err(`Warning: unreadable verification record ${p.file}: ${p.detail}`);

    if (mode === "report") {
      const report = buildVerificationReport({
        caseId,
        createdAt: now().toISOString(),
        referenceImageId: saved.reference.id,
        fingerprintId: saved.fingerprint.id,
        referenceSha256: saved.record.image.sha256,
        synthetic: isSynthetic || existing.records.some((r) => r.record.dataSource === "mock"),
        listings: imported.listings,
        suppliers: imported.suppliers,
        records: existing.records,
        recordProblems: existing.problems,
        shortlist,
        model,
        instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
      });
      const base = join(outputDir, caseId, "report");
      await mkdir(dirname(base), { recursive: true });
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(`${base}.md`, renderVerificationReportMarkdown(report));
      notice(`Saved ${display(`${base}.json`)} and ${display(`${base}.md`)} (no model request was made).`);
      io.out(json ? JSON.stringify(report, null, 2) : renderVerificationReportMarkdown(report));
      return VERIFY_EXIT_OK;
    }

    // Selection, evidence and duplicate check (dry run and live).
    let selected: CandidateListing[];
    if (listingId) {
      const listing = imported.listings.find((l) => l.id === listingId);
      if (!listing) throw new InputProblem(VERIFY_EXIT_USAGE, `Listing "${listingId}" is not in the manifest for ${caseId}`);
      selected = [listing];
    } else {
      selected = [...imported.listings];
    }
    if (cap !== undefined && cap > selected.length) {
      return usage(`--max-paid-requests ${cap} exceeds the ${selected.length} selected listing(s)`);
    }

    const referenceEvidence = await resolveReferenceImage(imagesPath, saved);
    const plans = await planListingImages(imported.listings, dirname(manifestPath), caseId);
    const evidence = new LocalVerificationEvidence(referenceEvidence, plans);
    const reference = await evidence.reference(saved.reference);
    const ctx: RecordContext = {
      caseId,
      dataSource: isSynthetic ? "mock" : "live",
      fingerprintId: saved.fingerprint.id,
      settings,
      instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
    };

    const plan: Plan[] = [];
    for (const listing of selected) {
      const candidate = await evidence.candidate(listing);
      if ("unusable" in candidate) {
        plan.push({ listing, candidate: null, unusable: candidate.unusable.map((r) => `${r.ref}: ${r.problem}`), existing: null, action: "skip_no_image" });
        continue;
      }
      const key = verificationKey({
        caseId,
        listingId: listing.id,
        referenceSha256: reference.sha256,
        candidateSha256: candidate.sha256,
        model: settings.model,
        instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
        imageDetail: settings.imageDetail,
        reasoningEffort: settings.reasoningEffort,
      });
      const matches = existing.records.filter((r) => recordKey(r.record) === key).sort((a, b) => (a.record.requestedAt < b.record.requestedAt ? 1 : -1));
      const prior = matches.find((r) => r.record.status === "succeeded") ?? matches[0];
      plan.push({
        listing,
        candidate,
        unusable: [],
        existing: prior ? { status: prior.record.status, file: prior.file } : null,
        action: prior && !flag("rerun") ? "skip_existing" : "request",
      });
    }
    const toRequest = plan.filter((p) => p.action === "request");

    const describePlan = () => {
      io.out(`Reference ${saved.reference.id} (fingerprint ${saved.fingerprint.id}): ${reference.mimeType} ${reference.width}x${reference.height}, sha256 ${reference.sha256}`);
      io.out(`Model ${settings.model}; instructions ${VISUAL_VERIFICATION_INSTRUCTIONS_VERSION}; detail ${settings.imageDetail}; reasoning ${settings.reasoningEffort}; max output tokens ${settings.maxOutputTokens}; timeout ${settings.timeoutMs} ms; retries 0; store false`);
      io.out(`Shortlist: ${shortlist ? `${display(shortlistPath)} (validated; used for the report only, never sent to the model)` : "none found (not needed for verification)"}`);
      for (const p of plan) {
        io.out(`- ${p.listing.id}${p.listing.marketplaceProductId ? ` (product ${p.listing.marketplaceProductId})` : ""}`);
        if (p.candidate) io.out(`    image ${p.candidate.ref}: ${p.candidate.mimeType} ${p.candidate.width}x${p.candidate.height}, sha256 ${p.candidate.sha256}`);
        if (p.action === "skip_no_image") io.out(`    SKIP: no usable image (${p.unusable.join("; ") || "no images recorded"}); stays not assessed`);
        else if (p.action === "skip_existing") io.out(`    SKIP: already recorded (${p.existing!.status}: ${p.existing!.file}); use --rerun to request again`);
        else io.out(`    will request${p.existing ? ` again (--rerun; previous ${p.existing.status})` : ""}`);
      }
      io.out(`Paid requests planned: ${toRequest.length}. Records go to ${display(join(outputDir, caseId))}/<listing>/.`);
    };

    if (mode === "dry-run") {
      io.out(`# Visual verification dry run: ${caseId} (no request was sent)`);
      describePlan();
      io.out(`OPENAI_API_KEY: ${deps.env.OPENAI_API_KEY?.trim() ? "set" : "NOT SET (required for --live)"}`);
      io.out(
        toRequest.length
          ? `To send them: add --live --max-paid-requests ${toRequest.length} with ${listingId ? `--listing-id ${listingId}` : "--all"}.`
          : "Nothing to request.",
      );
      return VERIFY_EXIT_OK;
    }

    // Live.
    const apiKey = deps.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new InputProblem(VERIFY_EXIT_USAGE, "OPENAI_API_KEY is not set. Add it to apps/web/.env.local (see .env.example).");
    io.out(`# Visual verification: ${caseId} (LIVE, at most ${cap} paid request(s))`);
    describePlan();
    if (toRequest.length > cap!) {
      throw new InputProblem(VERIFY_EXIT_USAGE, `${toRequest.length} request(s) are planned but --max-paid-requests is ${cap}. Nothing was sent.`);
    }
    if (toRequest.length === 0) {
      io.out("Nothing to request.");
      return VERIFY_EXIT_OK;
    }

    const createClient: VerificationClientFactory =
      deps.createClient ?? ((key, m, s) => OpenAIVisualVerificationClient.fromApiKey(key, { model: m, settings: s }));
    const client = createClient(apiKey, settings.model, {
      imageDetail: settings.imageDetail,
      reasoningEffort: settings.reasoningEffort,
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
    });
    const budget = new PaidRequestBudget(cap!);
    let persistenceFailed = false;
    const outcomes: PairOutcome[] = [];
    const service = new OpenAIVisualVerificationService({
      client,
      evidence,
      budget,
      now,
      // If the pending record cannot be written, the request is not sent.
      onRequestStart: async (attempt) => {
        try {
          await writePendingRecord(outputDir, pendingRecord(ctx, attempt));
        } catch {
          throw new PendingRecordError(`Could not create the record for ${attempt.listing.id} in ${display(outputDir)}; that request was not sent`);
        }
      },
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
        const record = finalRecord(ctx, outcome);
        if (!record) return;
        try {
          const path = await writeFinalRecord(outputDir, record);
          io.out(`  ${outcome.listing.id}: ${record.status}${record.assessment ? ` — ${record.assessment.classification}, index ${record.assessment.designSimilarityIndex ?? "null"}, confidence ${record.assessment.confidence}` : record.error ? ` — ${record.error.category}: ${record.error.message}` : ""} → ${display(path)}`);
        } catch {
          persistenceFailed = true;
          io.err(`Error: could not save the record for ${outcome.listing.id}. Recoverable copy (no image data):`);
          io.err(JSON.stringify(record));
        }
      },
    });
    await service.verify({ reference: saved.reference, fingerprint: saved.fingerprint, listings: toRequest.map((p) => p.listing) });

    const failed = outcomes.filter((o) => o.status !== "succeeded" && o.status !== "no_usable_image");
    const notSent = outcomes.filter((o) => o.status === "not_requested");
    io.out(`Paid requests sent: ${budget.spent} of at most ${cap}. Succeeded: ${outcomes.filter((o) => o.status === "succeeded").length}; unsuccessful: ${failed.length - notSent.length}; not sent: ${notSent.length}.`);
    if (notSent.length) io.out(`Not sent (stopped after an access/rate-limit error): ${notSent.map((o) => o.listing.id).join(", ")}`);
    if (failed.length) io.out("Unsuccessful requests are not retried automatically; review the records before using --rerun.");
    if (persistenceFailed) return VERIFY_EXIT_PERSISTENCE;
    return failed.length ? VERIFY_EXIT_REQUEST_FAILED : VERIFY_EXIT_OK;
  } catch (error) {
    if (error instanceof InputProblem) {
      io.err(`Error: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof EvidenceError) {
      io.err(`Error: ${error.message}`);
      return VERIFY_EXIT_INVALID;
    }
    if (error instanceof PendingRecordError) {
      io.err(`Error: ${error.message}. Records saved before it are kept.`);
      return VERIFY_EXIT_PERSISTENCE;
    }
    throw error;
  }
}
