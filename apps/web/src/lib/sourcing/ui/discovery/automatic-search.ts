import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkSourceEligibility,
  imageRetrievalAllowed,
  loadAccessRecord,
  PROVIDERS,
  rawRetentionAllowed,
  type AccessRecordLoad,
  type SourceEligibility,
} from "../../discovery/authorization";
import { candidateManifestSchema, type CandidateManifest } from "../../discovery/curated/manifest";
import { acquireListingImages, type ImageOutcome } from "../../discovery/images/acquire-images";
import { pythonAvifConverter } from "../../discovery/images/avif-converter";
import { DEFAULT_IMAGE_FETCH_POLICY, safeFetchImage, type FetchedImage } from "../../discovery/images/safe-image-fetch";
import { describeDiscoveryState } from "../../discovery/providers/apify/discovery-run";
import { loadJournal, saveJournal, writeJsonAtomic, type DiscoveryRunJournal } from "../../discovery/providers/apify/run-journal";
import { createExaJournal, executeExaRuns, normalizeExaSavedRuns, planExaDiscovery } from "../../discovery/providers/exa/discovery-run";
import { EXA_CREDENTIAL_ENV, EXA_LIMITS, EXA_PROVIDER_ID, exaSearch, type FetchLike } from "../../discovery/providers/exa/exa-api";
import type { ExaManifestBuild } from "../../discovery/providers/exa/normalize";
import { loadSavedFingerprint, type SavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { withFileLock } from "../analysis/register";
import { CASE_ID, type Paths } from "../data";
import { readConfined, type EvidenceResult } from "../evidence";

/**
 * Automatic product search for an analysed photo, through the one implemented
 * keyword source (Exa, an external search index restricted to Alibaba.com
 * product pages). Server-side only: the API key never leaves the server.
 *
 * Every start is gated by the same eligibility check as the CLI (project
 * policy, recorded access, credentials, live switch); today the policy check
 * fails for Exa, so nothing can be sent. A start needs an explicit
 * confirmation with a one-time request key: repeating the same key returns the
 * same run, and a second run for a case is refused while one is unfinished, so
 * a refresh or double click never sends another search. Results are saved as a
 * separate candidate set under evals/local/discovery/<case>/<run>/; the
 * operator-assisted list is never read for writing.
 */

export const DISCOVERY_ID = /^disc-[0-9TZ-]+-[0-9a-f]{6}$/;
const REQUEST_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AutomaticSearchDeps {
  env?: Record<string, string | undefined>;
  /** Exa transport; defaults to global fetch. */
  fetch?: FetchLike;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  convertAvif?: ((avifPath: string, sha256: string, pngPath: string) => Promise<void>) | null;
  /** Replaces the eligibility check (tests only); the default reads the private access record. */
  checkAccess?: () => Promise<{ eligibility: SourceEligibility; access: AccessRecordLoad }>;
  now?: () => Date;
}

export interface AutomaticSearchPlan {
  providerId: string;
  providerLabel: string;
  sends: "text_only";
  queries: string[];
  resultsPerQuery: number;
  maxRequests: number;
  maxUniqueLeads: number;
  estimatedUsd: number;
  costCapUsd: number;
  eligibility: SourceEligibility;
  imageRetrieval: { allowed: boolean; detail: string };
  rawRetention: boolean;
  problems: string[];
}

async function realAccess(paths: Paths, env: Record<string, string | undefined>) {
  const access = await loadAccessRecord(paths.marketplaceAccess);
  return { access, eligibility: checkSourceEligibility({ providerId: EXA_PROVIDER_ID, mode: "keyword", env, access }) };
}

/** The confirmation plan. Reads saved records and configuration only. */
export async function automaticSearchPlan(paths: Paths, saved: SavedFingerprint, deps: AutomaticSearchDeps = {}): Promise<AutomaticSearchPlan> {
  const env = deps.env ?? process.env;
  const { eligibility, access } = deps.checkAccess ? await deps.checkAccess() : await realAccess(paths, env);
  const maxUniqueLeads = Math.min(EXA_LIMITS.maxUniqueLeads, eligibility.limits?.maxResults ?? EXA_LIMITS.maxUniqueLeads);
  const costCapUsd = Math.min(EXA_LIMITS.maxCostUsd, eligibility.limits?.maxCostUsd ?? 0.25);
  const plan = planExaDiscovery({ saved, maxQueries: EXA_LIMITS.maxQueries, resultsPerQuery: EXA_LIMITS.maxResultsPerQuery, maxUniqueLeads, costCapUsd });
  return {
    providerId: EXA_PROVIDER_ID,
    providerLabel: PROVIDERS[EXA_PROVIDER_ID].label,
    sends: "text_only",
    queries: plan.queries,
    resultsPerQuery: EXA_LIMITS.maxResultsPerQuery,
    maxRequests: plan.queries.length,
    maxUniqueLeads,
    estimatedUsd: plan.estimatedUsd,
    costCapUsd,
    eligibility,
    imageRetrieval: imageRetrievalAllowed(eligibility, access),
    rawRetention: rawRetentionAllowed(EXA_PROVIDER_ID, access),
    problems: plan.problems,
  };
}

export type StartOutcome =
  | { ok: true; discoveryId: string; reused: boolean; status: DiscoveryRunJournal["status"] }
  | { ok: false; status: 400 | 404 | 409; code: "invalid_request" | "not_confirmed" | "not_found" | "not_eligible" | "already_running" | "invalid_plan"; message: string };

async function journals(caseDir: string): Promise<{ dir: string; journal: DiscoveryRunJournal }[]> {
  const names = await readdir(caseDir).catch(() => [] as string[]);
  const out: { dir: string; journal: DiscoveryRunJournal }[] = [];
  for (const name of names.filter((n) => DISCOVERY_ID.test(n)).sort()) {
    const dir = join(caseDir, name);
    const journal = await loadJournal(dir).catch(() => null);
    if (journal) out.push({ dir, journal });
  }
  return out;
}

/** Unfinished: no summary written and not settled as completed or failed. */
const unfinished = (j: DiscoveryRunJournal) => j.summaryFile === null && j.status !== "completed" && j.status !== "failed";

export async function startAutomaticSearch(
  paths: Paths,
  caseId: string,
  input: { requestKey: string; confirmed: boolean },
  deps: AutomaticSearchDeps = {},
): Promise<StartOutcome> {
  if (!CASE_ID.test(caseId) || !REQUEST_KEY.test(input.requestKey)) return { ok: false, status: 400, code: "invalid_request", message: "Invalid case or request key" };
  if (!input.confirmed) return { ok: false, status: 400, code: "not_confirmed", message: "Confirm the search first." };
  let saved: SavedFingerprint;
  try {
    saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  } catch {
    return { ok: false, status: 404, code: "not_found", message: "This photo has no saved analysis." };
  }
  if (saved.fingerprint.source.dataSource === "mock") return { ok: false, status: 409, code: "not_eligible", message: "Synthetic analyses are never searched." };
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const caseDir = join(paths.discovery, caseId);
  await mkdir(caseDir, { recursive: true });

  const started = await withFileLock(join(caseDir, "start"), async (): Promise<StartOutcome | { runDir: string; journal: DiscoveryRunJournal; plan: AutomaticSearchPlan }> => {
    const existing = await journals(caseDir);
    const same = existing.find((e) => e.journal.request.requestKey === input.requestKey);
    if (same) return { ok: true, discoveryId: same.journal.discoveryId, reused: true, status: same.journal.status };
    if (existing.some((e) => unfinished(e.journal))) {
      return { ok: false, status: 409, code: "already_running", message: "An automatic search for this photo has not finished. It is never restarted automatically." };
    }
    const plan = await automaticSearchPlan(paths, saved, deps);
    if (!plan.eligibility.eligible) return { ok: false, status: 409, code: "not_eligible", message: plan.eligibility.blocker ?? "No eligible source" };
    if (plan.problems.length) return { ok: false, status: 409, code: "invalid_plan", message: plan.problems.join("; ") };
    const { journal } = createExaJournal({
      caseId,
      saved,
      maxQueries: EXA_LIMITS.maxQueries,
      resultsPerQuery: plan.resultsPerQuery,
      maxUniqueLeads: plan.maxUniqueLeads,
      costCapUsd: plan.costCapUsd,
      retainRawResponses: plan.rawRetention,
      requestKey: input.requestKey,
      now: now(),
    });
    const runDir = join(caseDir, journal.discoveryId);
    await mkdir(runDir);
    await saveJournal(runDir, journal); // recorded (and visible as unfinished) before anything is sent
    return { runDir, journal, plan };
  });
  if ("ok" in started) return started;

  const { runDir, journal, plan } = started;
  const apiKey = env[EXA_CREDENTIAL_ENV] ?? "";
  const transport = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  await executeExaRuns({ runDir, now, search: (body) => exaSearch(body, { apiKey, fetch: transport }) }, journal, { startPlanned: true });
  await finalizeAutomaticSearch(runDir, journal, saved, plan.imageRetrieval.allowed, deps, paths);
  return { ok: true, discoveryId: journal.discoveryId, reused: false, status: journal.status };
}

export interface AutomaticSearchSummary {
  recordType: "automatic_search_summary";
  schemaVersion: 1;
  discoveryId: string;
  provider: { providerId: string; access: string; source: string };
  queries: string[];
  requests: { planned: number; succeeded: number; failed: number; uncertain: number; notSent: number };
  costUsd: { reported: number; unreported: number; capUsd: number };
  /** Null when no request succeeded: a failed search, not an empty result. */
  counts: {
    resultsReturned: number;
    alibabaProductLinks: number;
    furnitureListings: number;
    uniqueProducts: number;
    duplicates: number;
    withImageUrl: number;
    withLocalImage: number;
    imagesRejected: number;
    withSupplier: number;
    withPrice: number;
    withMinimumOrder: number;
  } | null;
  rejections: Record<string, number>;
  imageFailures: { listingUrl: string; reason: string }[];
  imageRetrieval: "done" | "not_approved" | "not_attempted";
  manifest: string | null;
  errors: string[];
}

function summarize(
  journal: DiscoveryRunJournal,
  build: ExaManifestBuild | null,
  manifest: CandidateManifest | null,
  images: ImageOutcome[] | null,
  imageRetrieval: AutomaticSearchSummary["imageRetrieval"],
): AutomaticSearchSummary {
  const rejections: Record<string, number> = {};
  for (const r of build?.rejections ?? []) rejections[r.reason] = (rejections[r.reason] ?? 0) + 1;
  const n = (k: string) => rejections[k] ?? 0;
  const runs = journal.runs;
  return {
    recordType: "automatic_search_summary",
    schemaVersion: 1,
    discoveryId: journal.discoveryId,
    provider: { providerId: journal.provider.providerId, access: journal.provider.access, source: journal.provider.source },
    queries: runs.flatMap((r) => r.queries),
    requests: {
      planned: runs.length,
      succeeded: runs.filter((r) => r.state === "succeeded").length,
      failed: runs.filter((r) => (r.state === "failed" || r.state === "start_failed") && r.error?.category !== "uncertain").length,
      uncertain: runs.filter((r) => r.error?.category === "uncertain").length,
      notSent: runs.filter((r) => r.state === "planned").length,
    },
    costUsd: {
      reported: Math.round(runs.reduce((s, r) => s + (r.usageTotalUsd ?? 0), 0) * 10_000) / 10_000,
      unreported: runs.filter((r) => r.state === "succeeded" && r.usageTotalUsd === null).length,
      capUsd: journal.request.costCapUsd,
    },
    counts:
      build && manifest
        ? {
            resultsReturned: build.rawCount,
            alibabaProductLinks: build.rawCount - n("not_an_object") - n("invalid_url") - n("not_alibaba") - n("not_product_page"),
            furnitureListings: build.rawCount - n("not_an_object") - n("invalid_url") - n("not_alibaba") - n("not_product_page") - n("missing_title") - n("not_furniture"),
            uniqueProducts: manifest.candidates.length,
            duplicates: build.duplicatesMerged + n("duplicate"),
            withImageUrl: manifest.candidates.filter((c) => c.images.some((i) => "url" in i)).length,
            withLocalImage: manifest.candidates.filter((c) => c.images.some((i) => "localPath" in i)).length,
            imagesRejected: (images ?? []).filter((o) => o.status === "failed").length + build.warnings.filter((w) => w.warning.startsWith("preview image ignored")).length,
            withSupplier: manifest.candidates.filter((c) => c.supplierRef).length,
            withPrice: manifest.candidates.filter((c) => c.price).length,
            withMinimumOrder: manifest.candidates.filter((c) => c.minimumOrder).length,
          }
        : null,
    rejections,
    imageFailures: (images ?? []).filter((o) => o.status === "failed").map((o) => ({ listingUrl: o.listingUrl, reason: "reason" in o ? o.reason : o.status })),
    imageRetrieval,
    manifest: manifest ? `${journal.caseId}.json` : null,
    errors: runs.filter((r) => r.error).map((r) => `"${r.queries[0]}": ${r.error!.category} — ${r.error!.message}`),
  };
}

async function finalizeAutomaticSearch(runDir: string, journal: DiscoveryRunJournal, saved: SavedFingerprint, imagesAllowed: boolean, deps: AutomaticSearchDeps, paths: Paths) {
  let build: ExaManifestBuild | null = null;
  let manifest: CandidateManifest | null = null;
  let images: ImageOutcome[] | null = null;
  if (journal.runs.some((r) => r.state === "succeeded")) {
    build = await normalizeExaSavedRuns(runDir, journal, saved);
    manifest = build.manifest;
    if (imagesAllowed && manifest.candidates.length) {
      ({ manifest, outcomes: images } = await acquireImages(runDir, journal, manifest, deps, paths));
    }
    await writeJsonAtomic(join(runDir, `${journal.caseId}.json`), manifest);
    journal.manifestFile = `${journal.caseId}.json`;
    journal.status = "completed";
  } else {
    journal.status = "failed";
  }
  const summary = summarize(journal, build, manifest, images, images ? "done" : imagesAllowed ? "not_attempted" : "not_approved");
  await writeJsonAtomic(join(runDir, "import-summary.json"), summary);
  journal.summaryFile = "import-summary.json";
  journal.updatedAt = (deps.now ?? (() => new Date()))().toISOString();
  await saveJournal(runDir, journal);
}

async function acquireImages(runDir: string, journal: DiscoveryRunJournal, manifest: CandidateManifest, deps: AutomaticSearchDeps, paths: Paths) {
  const acquired = await acquireListingImages(manifest, {
    runDir,
    caseId: journal.caseId,
    imagesPerListing: 1,
    maxImages: journal.request.maxResults,
    fetchImage: deps.fetchImage ?? ((url) => safeFetchImage(url, DEFAULT_IMAGE_FETCH_POLICY)),
    convertAvif: deps.convertAvif !== undefined ? deps.convertAvif : pythonAvifConverter(paths.root),
  });
  await writeJsonAtomic(join(runDir, "images.json"), { recordType: "discovery_image_evidence", schemaVersion: 1, outcomes: acquired.outcomes });
  return { manifest: candidateManifestSchema.parse(acquired.manifest), outcomes: acquired.outcomes };
}

/** Caches the found listings' preview images later, once retrieval is approved. Never repeats the search. */
export async function fetchAutomaticSearchImages(paths: Paths, caseId: string, discoveryId: string, deps: AutomaticSearchDeps = {}): Promise<StartOutcome> {
  if (!CASE_ID.test(caseId) || !DISCOVERY_ID.test(discoveryId)) return { ok: false, status: 400, code: "invalid_request", message: "Invalid case or search id" };
  const runDir = join(paths.discovery, caseId, discoveryId);
  return withFileLock(join(runDir, "images"), async () => {
    const journal = await loadJournal(runDir).catch(() => null);
    if (!journal || journal.caseId !== caseId || journal.provider.service !== "exa") return { ok: false, status: 404, code: "not_found", message: "No such automatic search" };
    if (!journal.manifestFile) return { ok: false, status: 409, code: "invalid_plan", message: "That search has no saved products." };
    const env = deps.env ?? process.env;
    const { eligibility, access } = deps.checkAccess ? await deps.checkAccess() : await realAccess(paths, env);
    const allowed = imageRetrievalAllowed(eligibility, access);
    if (!allowed.allowed) return { ok: false, status: 409, code: "not_eligible", message: allowed.detail };
    const saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
    const build = await normalizeExaSavedRuns(runDir, journal, saved);
    const { manifest, outcomes } = await acquireImages(runDir, journal, build.manifest, deps, paths);
    await writeJsonAtomic(join(runDir, journal.manifestFile), manifest);
    await writeJsonAtomic(join(runDir, "import-summary.json"), summarize(journal, build, manifest, outcomes, "done"));
    journal.updatedAt = (deps.now ?? (() => new Date()))().toISOString();
    await saveJournal(runDir, journal);
    return { ok: true, discoveryId, reused: false, status: journal.status };
  });
}

export interface AutomaticSearchView {
  discoveryId: string;
  createdAt: string;
  providerId: string;
  access: string;
  status: DiscoveryRunJournal["status"];
  unfinished: boolean;
  meaning: string;
  summary: AutomaticSearchSummary | null;
  /** Hash of the saved product set (manifest file bytes), to tell whether a comparison used exactly this set. */
  manifestSha256: string | null;
  products: { listingUrl: string; title: string; marketplaceProductId: string | null; localImage: string | null; price: CandidateManifest["candidates"][number]["price"] | null; minimumOrder: CandidateManifest["candidates"][number]["minimumOrder"] | null; queries: string[] }[];
}

/** Saved automatic searches for a case, newest first. Reads files only. */
export async function listAutomaticSearches(paths: Paths, caseId: string): Promise<AutomaticSearchView[]> {
  if (!CASE_ID.test(caseId)) return [];
  const views: AutomaticSearchView[] = [];
  for (const { dir, journal } of await journals(join(paths.discovery, caseId))) {
    // Catalogue searches (local records) are listed separately, never as marketplace searches.
    if (journal.caseId !== caseId || journal.provider.service === "local_catalogue") continue;
    const summary = journal.summaryFile ? ((await readFile(join(dir, journal.summaryFile), "utf8").then(JSON.parse).catch(() => null)) as AutomaticSearchSummary | null) : null;
    let manifest: CandidateManifest | null = null;
    let manifestSha256: string | null = null;
    if (journal.manifestFile) {
      const bytes = await readFile(join(dir, journal.manifestFile)).catch(() => null);
      const parsed = bytes ? candidateManifestSchema.safeParse(JSON.parse(bytes.toString("utf8"))) : null;
      if (bytes && parsed?.success) {
        manifest = parsed.data;
        manifestSha256 = createHash("sha256").update(bytes).digest("hex");
      }
    }
    views.push({
      discoveryId: journal.discoveryId,
      createdAt: journal.createdAt,
      providerId: journal.provider.providerId,
      access: journal.provider.access,
      status: journal.status,
      unfinished: unfinished(journal),
      meaning: describeDiscoveryState(journal).meaning,
      summary: summary?.recordType === "automatic_search_summary" ? summary : null,
      manifestSha256,
      products: (manifest?.candidates ?? []).map((c) => ({
        listingUrl: c.listingUrl,
        title: c.title,
        marketplaceProductId: c.marketplaceProductId ?? null,
        localImage: c.images.find((i): i is Extract<typeof i, { localPath: string }> => "localPath" in i)?.localPath ?? null,
        price: c.price ?? null,
        minimumOrder: c.minimumOrder ?? null,
        queries: (c.discoverySources ?? []).flatMap((d) => (d.query ? [d.query] : [])),
      })),
    });
  }
  return views.reverse();
}

/**
 * Continues an interrupted automatic search. A request recorded as sent but
 * without an outcome is settled as uncertain and never re-sent. Unsent queries
 * are sent only with `sendRemaining` (an explicit live confirmation) and only
 * while the source is still eligible; then results are saved as usual.
 */
export async function resumeAutomaticSearch(paths: Paths, caseId: string, discoveryId: string, input: { sendRemaining: boolean }, deps: AutomaticSearchDeps = {}): Promise<StartOutcome> {
  if (!CASE_ID.test(caseId) || !DISCOVERY_ID.test(discoveryId)) return { ok: false, status: 400, code: "invalid_request", message: "Invalid case or search id" };
  const runDir = join(paths.discovery, caseId, discoveryId);
  const journal = await loadJournal(runDir).catch(() => null);
  if (!journal || journal.caseId !== caseId || journal.provider.service !== "exa") return { ok: false, status: 404, code: "not_found", message: "No such automatic search" };
  if (journal.summaryFile) return { ok: true, discoveryId, reused: true, status: journal.status };
  const saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  const env = deps.env ?? process.env;
  const plan = await automaticSearchPlan(paths, saved, deps);
  if (input.sendRemaining && !plan.eligibility.eligible) return { ok: false, status: 409, code: "not_eligible", message: plan.eligibility.blocker ?? "No eligible source" };
  const now = deps.now ?? (() => new Date());
  const apiKey = env[EXA_CREDENTIAL_ENV] ?? "";
  const transport = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  await executeExaRuns({ runDir, now, search: (body) => exaSearch(body, { apiKey, fetch: transport }) }, journal, { startPlanned: input.sendRemaining });
  if (journal.runs.some((r) => r.state === "planned") && !input.sendRemaining) {
    // Unsent queries remain: they need an explicit live confirmation; keep the run open.
    return { ok: true, discoveryId, reused: false, status: journal.status };
  }
  await finalizeAutomaticSearch(runDir, journal, saved, plan.imageRetrieval.allowed, deps, paths);
  return { ok: true, discoveryId, reused: false, status: journal.status };
}

/**
 * Photo of the n-th product of a saved automatic search, for the browser. The
 * path comes from the run's own manifest and must stay inside its evidence
 * folder; cached files are named by their SHA-256, which is re-checked.
 */
export async function readDiscoveryImage(paths: Paths, caseId: string, discoveryId: string, index: number): Promise<EvidenceResult | null> {
  if (!CASE_ID.test(caseId) || !DISCOVERY_ID.test(discoveryId) || !Number.isInteger(index) || index < 0) return null;
  const runDir = join(paths.discovery, caseId, discoveryId);
  const journal = await loadJournal(runDir).catch(() => null);
  if (!journal || journal.caseId !== caseId || !journal.manifestFile) return null;
  const parsed = candidateManifestSchema.safeParse(JSON.parse(await readFile(join(runDir, journal.manifestFile), "utf8").catch(() => "null")));
  const local = parsed.success ? parsed.data.candidates[index]?.images.find((i): i is Extract<typeof i, { localPath: string }> => "localPath" in i) : undefined;
  if (!local || !local.localPath.startsWith(`${caseId}/`)) return null;
  const result = await readConfined(join(runDir, caseId), local.localPath.slice(caseId.length + 1), null);
  if (result.ok) {
    const stem = local.localPath.split("/").pop()!.split(".")[0];
    if (!/^[0-9a-f]{24}$/.test(stem) || !createHash("sha256").update(result.bytes).digest("hex").startsWith(stem)) {
      return { ok: false, status: 409, code: "changed", message: "The image changed after it was saved" };
    }
  }
  return result;
}
