import { join } from "node:path";
import type { SavedFingerprint } from "../../../understanding/saved/saved-fingerprint";
import { importCuratedCandidates } from "../../curated/curated-alibaba-adapter";
import type { CandidateManifest } from "../../curated/manifest";
import type { AlibabaDiscoveryAdapter, DiscoverySearchRequest, DiscoverySearchResult } from "../../types";
import {
  APIFY_PROVIDER_ID,
  buildImageSearchInput,
  buildKeywordInput,
  LIMITS,
  planDiscovery,
  PROVIDER_SOURCE_LABEL,
  SCRAPEWISE_ACTOR,
  type DiscoveryModeOption,
  type ImageTransport,
} from "./actor-input";
import { ApifyError, TERMINAL_STATUSES, type ApifyClient, type ApifyRun } from "./apify-client";
import { buildProviderManifest, normalizeRunRows, type ManifestBuild, type NormalizedRun, type ProviderErrorRow } from "./normalize";
import {
  loadSnapshot,
  newDiscoveryId,
  saveJournal,
  writeJsonAtomic,
  type DiscoveryRunJournal,
  type ProviderRunEntry,
  type ProviderRunState,
} from "./run-journal";

/**
 * Lifecycle of one automated discovery: plan → (start → poll → fetch rows) per
 * search mode → normalize into a provider_api candidate manifest. Each
 * provider run is started at most once; an interrupted or uncertain start is
 * recorded and can only be resumed by run id, never restarted automatically.
 */

export type ApifyApi = Pick<ApifyClient, "startRun" | "getRun" | "getDatasetItems" | "listRecentRuns">;

export interface ExecutionOptions {
  client: ApifyApi;
  runDir: string;
  now: () => Date;
  /** How long to wait for runs to finish before leaving them pending. */
  waitSeconds: number;
  /** Pause between polls when the server-side wait returns early. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const STATE_FROM_STATUS: Record<ApifyRun["status"], ProviderRunState> = {
  READY: "running",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  "TIMING-OUT": "running",
  "TIMED-OUT": "timed_out",
  ABORTING: "running",
  ABORTED: "aborted",
};

/** Item limit when reading a run's dataset: results plus room for error rows, bounded. */
export const datasetLimit = (maxResults: number) => Math.min(500, maxResults * 3 + 20);

export function createJournal(input: {
  caseId: string;
  saved: SavedFingerprint;
  mode: DiscoveryModeOption;
  maxResults: number;
  costCapUsd: number;
  maxQueries: number;
  imageTransport: ImageTransport | null;
  downloadImages: boolean;
  imagesPerListing: number;
  now: Date;
}): { journal: DiscoveryRunJournal; problems: string[] } {
  const plan = planDiscovery({
    mode: input.mode,
    maxResults: input.maxResults,
    fingerprintQueries: input.saved.fingerprint.searchQueries,
    maxQueries: input.maxQueries,
    costCapUsd: input.costCapUsd,
  });
  const at = input.now.toISOString();
  return {
    problems: plan.problems,
    journal: {
      recordType: "marketplace_discovery_run",
      schemaVersion: 1,
      discoveryId: newDiscoveryId(input.now),
      caseId: input.caseId,
      dataSource: "live",
      createdAt: at,
      updatedAt: at,
      status: "planned",
      provider: { providerId: APIFY_PROVIDER_ID, service: "apify", source: SCRAPEWISE_ACTOR, access: "third_party_service" },
      reference: { referenceImageId: input.saved.reference.id, fingerprintId: input.saved.fingerprint.id, sha256: input.saved.record.image.sha256 },
      request: {
        mode: input.mode,
        maxResults: input.maxResults,
        costCapUsd: input.costCapUsd,
        imageTransport: input.imageTransport,
        downloadImages: input.downloadImages,
        imagesPerListing: input.imagesPerListing,
      },
      runs: plan.runs.map((r) => ({
        mode: r.mode,
        state: "planned" as const,
        maxResults: r.maxResults,
        costCapUsd: r.costCapUsd,
        estimatedUsd: r.estimatedUsd,
        queries: r.queries,
        providerRunId: null,
        datasetId: null,
        startRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        statusMessage: null,
        chargedEventCounts: null,
        usageTotalUsd: null,
        error: null,
        snapshotFile: null,
        itemCount: null,
      })),
      storageUpload: null,
      manifestFile: null,
      summaryFile: null,
    },
  };
}

function applyRun(entry: ProviderRunEntry, run: ApifyRun): void {
  entry.providerRunId = run.id;
  entry.datasetId = run.datasetId;
  entry.state = STATE_FROM_STATUS[run.status];
  entry.startedAt = run.startedAt;
  entry.finishedAt = run.finishedAt;
  entry.statusMessage = run.statusMessage?.slice(0, 300) ?? null;
  entry.chargedEventCounts = run.chargedEventCounts;
  entry.usageTotalUsd = run.usageTotalUsd;
}

const TRANSIENT = new Set(["timeout", "network", "server_error", "rate_limit"]);

async function persist(opts: ExecutionOptions, journal: DiscoveryRunJournal): Promise<void> {
  journal.updatedAt = opts.now().toISOString();
  await saveJournal(opts.runDir, journal);
}

/** Starts a planned run once. A lost answer is recorded as start_uncertain and never retried. */
async function startRun(opts: ExecutionOptions, journal: DiscoveryRunJournal, entry: ProviderRunEntry): Promise<void> {
  const transport = journal.request.imageTransport;
  if (entry.mode === "image" && !transport) throw new Error("Image search needs an image transport");
  const input = entry.mode === "image" ? buildImageSearchInput(transport!, entry.maxResults) : buildKeywordInput(entry.queries, entry.maxResults);
  entry.state = "start_requested";
  entry.startRequestedAt = opts.now().toISOString();
  await persist(opts, journal); // recorded before the paid request is sent
  try {
    const run = await opts.client.startRun(SCRAPEWISE_ACTOR, input, {
      timeoutSecs: LIMITS.runTimeoutSecs,
      maxTotalChargeUsd: entry.costCapUsd,
      maxItems: entry.maxResults,
    });
    applyRun(entry, run);
    opts.log?.(`Started ${entry.mode} run ${run.id} (${run.status}).`);
  } catch (error) {
    const e = error instanceof ApifyError ? error : new ApifyError("network", "unexpected failure while starting the run");
    entry.state = TRANSIENT.has(e.category) ? "start_uncertain" : "start_failed";
    entry.error = { category: e.category, message: e.message };
  }
  await persist(opts, journal);
}

/** Polls until terminal or the wait budget ends. Read-only requests; transient errors are tolerated a few times. */
async function pollRun(opts: ExecutionOptions, journal: DiscoveryRunJournal, entry: ProviderRunEntry, deadline: number): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let transientFailures = 0;
  while (entry.state === "running" && entry.providerRunId) {
    const remaining = Math.floor((deadline - opts.now().getTime()) / 1000);
    if (remaining <= 0) return;
    try {
      const run = await opts.client.getRun(entry.providerRunId, Math.min(60, remaining));
      applyRun(entry, run);
      await persist(opts, journal);
      if (TERMINAL_STATUSES.has(run.status)) return;
    } catch (error) {
      if (!(error instanceof ApifyError) || !TRANSIENT.has(error.category) || ++transientFailures > 3) throw error;
    }
    await sleep(opts.pollIntervalMs ?? 2000);
  }
}

async function fetchRows(opts: ExecutionOptions, journal: DiscoveryRunJournal, entry: ProviderRunEntry): Promise<void> {
  if (entry.state !== "succeeded" || !entry.datasetId || !entry.providerRunId || entry.snapshotFile) return;
  const limit = datasetLimit(entry.maxResults);
  const items = await opts.client.getDatasetItems(entry.datasetId, limit);
  const file = `provider-response-${entry.mode}.json`;
  await writeJsonAtomic(join(opts.runDir, file), {
    recordType: "provider_response_snapshot",
    schemaVersion: 1,
    dataSource: journal.dataSource,
    source: PROVIDER_SOURCE_LABEL,
    mode: entry.mode,
    providerRunId: entry.providerRunId,
    datasetId: entry.datasetId,
    finishedAt: entry.finishedAt,
    fetchedAt: opts.now().toISOString(),
    itemLimit: limit,
    truncated: items.length >= limit,
    items,
  });
  entry.snapshotFile = file;
  entry.itemCount = items.length;
  await persist(opts, journal);
}

/** Starts planned runs (live) or only continues existing ones (resume), then polls and fetches rows. */
export async function advanceRuns(opts: ExecutionOptions, journal: DiscoveryRunJournal, { startPlanned }: { startPlanned: boolean }): Promise<void> {
  journal.status = "in_progress";
  await persist(opts, journal);
  const deadline = opts.now().getTime() + opts.waitSeconds * 1000;
  for (const entry of journal.runs) {
    if (entry.state === "planned") {
      if (!startPlanned) continue;
      await startRun(opts, journal, entry);
      const after = (entry as ProviderRunEntry).state as ProviderRunState; // updated by startRun
      // An access, payment or rate problem would repeat for the next mode, and an uncertain start must be reconciled first: stop.
      if (after === "start_failed" && entry.error && ["authentication", "payment_required", "permission", "rate_limit"].includes(entry.error.category)) break;
      if (after === "start_uncertain") break;
    }
    await pollRun(opts, journal, entry, deadline);
    await fetchRows(opts, journal, entry);
  }
  const states = journal.runs.map((r) => r.state);
  // Pending while any run may still be running or may have started; otherwise ready to normalize, or failed.
  if (states.some((s) => s === "running" || s === "start_requested" || s === "start_uncertain")) journal.status = "pending_provider";
  else journal.status = states.includes("succeeded") ? "in_progress" : "failed";
  await persist(opts, journal);
}

/**
 * Derived view of a discovery journal, kept apart from its recorded `status`.
 * The recorded "in_progress" means "provider work finished, results not yet
 * normalized into a manifest in this folder"; it never means a provider job is
 * running. Only `externalWorkPending` says whether anything is still running
 * (or may have started) at the provider.
 */
export interface DiscoveryStateView {
  recordedStatus: DiscoveryRunJournal["status"];
  providerRuns: { total: number; succeeded: number; failed: number; pending: number; notStarted: number };
  /** Succeeded runs whose rows were saved, so they can be processed offline. */
  snapshotsAvailable: number;
  /** A provider run is running, or its start is unconfirmed: resume it; never start another. */
  externalWorkPending: boolean;
  /** A normalized manifest was written to the run folder. */
  manifestRecorded: boolean;
  /** One-line explanation of the recorded status. */
  meaning: string;
}

export function describeDiscoveryState(journal: DiscoveryRunJournal): DiscoveryStateView {
  const count = (pred: (s: ProviderRunState) => boolean) => journal.runs.filter((r) => pred(r.state)).length;
  const pendingStates: ProviderRunState[] = ["running", "start_requested", "start_uncertain"];
  const view = {
    recordedStatus: journal.status,
    providerRuns: {
      total: journal.runs.length,
      succeeded: count((s) => s === "succeeded"),
      failed: count((s) => ["start_failed", "failed", "timed_out", "aborted"].includes(s)),
      pending: count((s) => pendingStates.includes(s)),
      notStarted: count((s) => s === "planned"),
    },
    snapshotsAvailable: journal.runs.filter((r) => r.state === "succeeded" && r.snapshotFile).length,
    externalWorkPending: journal.runs.some((r) => pendingStates.includes(r.state)),
    manifestRecorded: journal.manifestFile !== null,
  };
  const pendingMeaning = "a provider run is still running or its start is unconfirmed (resume it; do not start another)";
  const meaning = view.externalWorkPending ? pendingMeaning : {
    planned: "planned; no provider run was started",
    in_progress: view.externalWorkPending
      ? "provider runs in progress"
      : "provider runs finished; results not yet normalized into a manifest in this folder",
    pending_provider: pendingMeaning,
    completed: "provider runs finished and a manifest was written",
    failed: "no provider run succeeded (a failed search, not an empty result)",
  }[journal.status];
  return { ...view, meaning };
}

export interface FinalizedDiscovery {
  build: ManifestBuild;
  normalized: NormalizedRun[];
  providerErrors: ProviderErrorRow[];
}

/** Normalizes the saved snapshots of succeeded runs into a manifest. No network. */
export async function normalizeSavedRuns(runDir: string, journal: DiscoveryRunJournal, saved: SavedFingerprint): Promise<FinalizedDiscovery> {
  const succeeded = journal.runs.filter((r) => r.state === "succeeded" && r.snapshotFile && r.providerRunId);
  if (succeeded.length === 0) throw new Error("No provider run has succeeded with saved results");
  const normalized: NormalizedRun[] = [];
  for (const entry of succeeded) {
    const snapshot = await loadSnapshot(join(runDir, entry.snapshotFile!));
    if (snapshot.providerRunId !== entry.providerRunId || snapshot.mode !== entry.mode || snapshot.dataSource !== journal.dataSource) {
      throw new Error(`Snapshot ${entry.snapshotFile} does not belong to the ${entry.mode} run in run.json`);
    }
    normalized.push(
      normalizeRunRows(
        { mode: entry.mode, providerRunId: entry.providerRunId!, capturedAt: entry.finishedAt ?? snapshot.fetchedAt, items: snapshot.items },
        journal.dataSource,
      ),
    );
  }
  const capturedAt = succeeded.map((r) => r.finishedAt ?? journal.updatedAt).sort().at(-1)!;
  const build = buildProviderManifest({
    caseId: journal.caseId,
    referenceImageId: saved.reference.id,
    fingerprintId: saved.fingerprint.id,
    dataSource: journal.dataSource,
    capturedAt: new Date(capturedAt).toISOString(),
    runs: succeeded.map((r) => ({
      mode: r.mode,
      providerRunId: r.providerRunId!,
      status: r.state,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      chargedUsd: r.usageTotalUsd,
    })),
    normalized,
    queries: succeeded.flatMap((r) => r.queries),
    notes: `Automated discovery ${journal.discoveryId} via ${PROVIDER_SOURCE_LABEL}, a third-party scraper run on Apify (not an official Alibaba.com API). Listing and supplier data are as scraped from Alibaba.com and unverified.`,
  });
  return { build, normalized, providerErrors: normalized.flatMap((n) => n.providerErrors) };
}

/**
 * AlibabaDiscoveryAdapter backed by the Apify Actor. Runs the provider search
 * for the request (one run per mode, budgeted), and returns listings and
 * suppliers through the same manifest normalization the CLI saves.
 * Never scores similarity. Image transport and budget come from the caller.
 */
export class ApifyAlibabaDiscoveryAdapter implements AlibabaDiscoveryAdapter {
  lastBuild: ManifestBuild | undefined;
  lastJournal: DiscoveryRunJournal | undefined;

  constructor(
    private readonly options: ExecutionOptions & {
      caseId: string;
      saved: SavedFingerprint;
      imageTransport: ImageTransport | null;
      costCapUsd: number;
      maxQueries: number;
    },
  ) {}

  async discoverCandidates(request: DiscoverySearchRequest): Promise<DiscoverySearchResult> {
    const { saved } = this.options;
    if (request.reference.id !== saved.reference.id) throw new Error("Request reference does not match the saved fingerprint's reference");
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > LIMITS.maxResults) {
      throw new RangeError(`limit must be 1-${LIMITS.maxResults}`);
    }
    const mode: DiscoveryModeOption = request.mode === "image" ? "image" : request.mode === "text" ? "keyword" : "hybrid";
    const fingerprint = request.queries ? { ...saved.fingerprint, searchQueries: request.queries } : saved.fingerprint;
    const { journal, problems } = createJournal({
      caseId: this.options.caseId,
      saved: { ...saved, fingerprint },
      mode,
      maxResults: request.limit,
      costCapUsd: this.options.costCapUsd,
      maxQueries: this.options.maxQueries,
      imageTransport: this.options.imageTransport,
      downloadImages: false,
      imagesPerListing: 1,
      now: this.options.now(),
    });
    if (problems.length) throw new Error(problems.join("; "));
    if (mode !== "keyword" && !this.options.imageTransport) throw new Error("Image search needs an image transport");
    this.lastJournal = journal;
    await advanceRuns(this.options, journal, { startPlanned: true });
    const failed = journal.runs.filter((r) => r.state !== "succeeded");
    if (failed.length) {
      throw new ApifyError("server_error", `Provider run(s) did not succeed: ${failed.map((r) => `${r.mode} ${r.state}${r.error ? ` (${r.error.category})` : ""}`).join(", ")}`);
    }
    const { build } = await normalizeSavedRuns(this.options.runDir, journal, saved);
    this.lastBuild = build;
    return manifestToDiscoveryResult(build.manifest, request.limit);
  }
}

/** Domain view of a provider_api manifest, via the shared manifest importer. */
export function manifestToDiscoveryResult(manifest: CandidateManifest, limit: number): DiscoverySearchResult {
  const imported = importCuratedCandidates([manifest]);
  const listings = imported.listings.slice(0, limit);
  const supplierIds = new Set(listings.flatMap((l) => l.supplierId ?? []));
  return {
    listings,
    suppliers: imported.suppliers.filter((s) => supplierIds.has(s.id)),
    provider: { providerId: APIFY_PROVIDER_ID, marketplace: "alibaba", dataSource: manifest.dataSource, acquisitionMethod: "provider_api" },
    retrievedAt: imported.capturedAt,
    queriesUsed: imported.queriesTyped,
  };
}
