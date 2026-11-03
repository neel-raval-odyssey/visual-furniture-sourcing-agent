import { join } from "node:path";
import type { SavedFingerprint } from "../../../understanding/saved/saved-fingerprint";
import { loadSnapshot, newDiscoveryId, saveJournal, writeJsonAtomic, type DiscoveryRunJournal, type ProviderRunEntry } from "../apify/run-journal";
import {
  buildSearchBody,
  estimateSearchCostUsd,
  EXA_LIMITS,
  EXA_PROVIDER_ID,
  EXA_SOURCE_LABEL,
  ExaError,
  isUncertainOutcome,
  type ExaSearchBody,
  type ExaSearchResponse,
} from "./exa-api";
import { buildExaManifest, type ExaManifestBuild, type ExaQueryRows } from "./normalize";

/**
 * One automated discovery through Exa: plan (saved Luna queries, unchanged) →
 * one search request per query, sequentially, each recorded in run.json before
 * it is sent → saved per-query snapshots → offline normalization into a
 * provider_api manifest. A request whose answer was lost is never re-sent: it
 * is recorded as failed with an "uncertain" outcome (it may have been billed).
 * Sending stops at the first access, payment, rate-limit or uncertain failure,
 * or when the next request could exceed the cost cap.
 */

export interface ExaPlanInput {
  caseId: string;
  saved: SavedFingerprint;
  maxQueries: number;
  resultsPerQuery: number;
  maxUniqueLeads: number;
  costCapUsd: number;
  retainRawResponses: boolean;
  requestKey?: string;
  dataSource?: "live" | "mock";
  now: Date;
}

export function planExaDiscovery(input: Pick<ExaPlanInput, "saved" | "maxQueries" | "resultsPerQuery" | "maxUniqueLeads" | "costCapUsd">): {
  queries: string[];
  perRequestUsd: number;
  estimatedUsd: number;
  problems: string[];
} {
  const problems: string[] = [];
  if (!Number.isInteger(input.maxQueries) || input.maxQueries < 1 || input.maxQueries > EXA_LIMITS.maxQueries) problems.push(`max queries must be 1-${EXA_LIMITS.maxQueries}`);
  if (!Number.isInteger(input.resultsPerQuery) || input.resultsPerQuery < 1 || input.resultsPerQuery > EXA_LIMITS.maxResultsPerQuery) {
    problems.push(`results per query must be 1-${EXA_LIMITS.maxResultsPerQuery}`);
  }
  if (!Number.isInteger(input.maxUniqueLeads) || input.maxUniqueLeads < 1 || input.maxUniqueLeads > EXA_LIMITS.maxUniqueLeads) problems.push(`max unique leads must be 1-${EXA_LIMITS.maxUniqueLeads}`);
  if (!(input.costCapUsd > 0) || input.costCapUsd > EXA_LIMITS.maxCostUsd) problems.push(`cost cap must be above 0 and at most $${EXA_LIMITS.maxCostUsd}`);
  // The saved queries are used exactly as Luna wrote them, in order; duplicates are dropped.
  const queries = [...new Set(input.saved.fingerprint.searchQueries.map((q) => q.trim()).filter(Boolean))].slice(0, Math.max(0, Math.min(input.maxQueries, EXA_LIMITS.maxQueries)));
  if (queries.length === 0) problems.push("The saved photo analysis has no search queries");
  const perRequestUsd = problems.length ? 0 : estimateSearchCostUsd(input.resultsPerQuery);
  const estimatedUsd = Math.round(perRequestUsd * queries.length * 10_000) / 10_000;
  if (!problems.length && estimatedUsd > input.costCapUsd) problems.push(`estimated cost $${estimatedUsd} is above the cap of $${input.costCapUsd}`);
  return { queries, perRequestUsd, estimatedUsd, problems };
}

export function createExaJournal(input: ExaPlanInput): { journal: DiscoveryRunJournal; problems: string[] } {
  const plan = planExaDiscovery(input);
  const at = input.now.toISOString();
  return {
    problems: plan.problems,
    journal: {
      recordType: "marketplace_discovery_run",
      schemaVersion: 1,
      discoveryId: newDiscoveryId(input.now),
      caseId: input.caseId,
      dataSource: input.dataSource ?? "live",
      createdAt: at,
      updatedAt: at,
      status: "planned",
      provider: { providerId: EXA_PROVIDER_ID, service: "exa", source: EXA_SOURCE_LABEL, access: "external_search_index" },
      reference: { referenceImageId: input.saved.reference.id, fingerprintId: input.saved.fingerprint.id, sha256: input.saved.record.image.sha256 },
      request: {
        mode: "keyword",
        maxResults: input.maxUniqueLeads,
        costCapUsd: input.costCapUsd,
        imageTransport: null,
        downloadImages: false,
        imagesPerListing: 1,
        resultsPerQuery: input.resultsPerQuery,
        retainRawResponses: input.retainRawResponses,
        ...(input.requestKey ? { requestKey: input.requestKey } : {}),
      },
      runs: (plan.queries.length ? plan.queries : ["(none)"]).map((q) => ({
        mode: "keyword" as const,
        state: "planned" as const,
        maxResults: input.resultsPerQuery,
        costCapUsd: input.costCapUsd,
        estimatedUsd: plan.perRequestUsd,
        queries: [q],
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

export interface ExaExecutionOptions {
  /** Sends one documented search request (exaSearch bound to a key and fetch). */
  search: (body: ExaSearchBody) => Promise<ExaSearchResponse>;
  runDir: string;
  now: () => Date;
  log?: (line: string) => void;
}

const STOP_AFTER = new Set(["authentication", "payment_required", "permission", "rate_limit", "uncertain"]);

/** Cost already committed: reported charges, or the estimate when a charge was not reported. */
export function committedUsd(journal: DiscoveryRunJournal): number {
  return journal.runs
    .filter((r) => r.state === "succeeded" || (r.state === "failed" && r.error?.category === "uncertain"))
    .reduce((sum, r) => sum + (r.usageTotalUsd ?? r.estimatedUsd), 0);
}

async function persist(opts: ExaExecutionOptions, journal: DiscoveryRunJournal) {
  journal.updatedAt = opts.now().toISOString();
  await saveJournal(opts.runDir, journal);
}

/** Only the fields this application uses, unless keeping full responses was approved in the access record. */
function snapshotItems(response: ExaSearchResponse, raw: boolean): unknown[] {
  if (raw) return response.results;
  return response.results.map((r) => {
    if (!r || typeof r !== "object") return r;
    const o = r as Record<string, unknown>;
    return { url: o.url, title: o.title ?? null, id: o.id ?? null, publishedDate: o.publishedDate ?? null, image: o.image ?? null, highlights: o.highlights ?? null };
  });
}

/**
 * A request recorded as sent but without an outcome (the process stopped) is
 * settled as uncertain and never re-sent. Returns how many were settled.
 */
export function settleInterrupted(journal: DiscoveryRunJournal): number {
  let n = 0;
  for (const r of journal.runs) {
    if (r.state === "start_requested" || r.state === "start_uncertain" || r.state === "running") {
      r.state = "failed";
      r.error = { category: "uncertain", message: "Interrupted after the request was sent; it may have been processed and billed. It is not sent again." };
      n++;
    }
  }
  return n;
}

/** Sends the planned requests in order (live) or only settles interrupted ones (startPlanned false). */
export async function executeExaRuns(opts: ExaExecutionOptions, journal: DiscoveryRunJournal, { startPlanned }: { startPlanned: boolean }): Promise<void> {
  if (journal.provider.service !== "exa") throw new Error("Not an Exa discovery run");
  settleInterrupted(journal);
  journal.status = "in_progress";
  await persist(opts, journal);
  for (const [i, entry] of journal.runs.entries()) {
    if (entry.state !== "planned" || !startPlanned) continue;
    if (committedUsd(journal) + entry.estimatedUsd > journal.request.costCapUsd + 1e-9) {
      opts.log?.(`Stopped before query ${i + 1}: it could exceed the $${journal.request.costCapUsd} cap.`);
      break;
    }
    entry.state = "start_requested";
    entry.startRequestedAt = opts.now().toISOString();
    await persist(opts, journal); // recorded before the billable request is sent
    try {
      const response = await opts.search(buildSearchBody(entry.queries[0], entry.maxResults));
      await recordSuccess(opts, journal, entry, i, response);
      opts.log?.(`Query ${i + 1}: ${response.results.length} result(s).`);
    } catch (error) {
      const e = error instanceof ExaError ? error : new ExaError("network", "Unexpected failure while sending the search");
      entry.finishedAt = opts.now().toISOString();
      if (isUncertainOutcome(e)) {
        entry.state = "failed";
        entry.error = { category: "uncertain", message: `${e.message}. Not re-sent automatically.` };
      } else {
        entry.state = "start_failed";
        entry.error = { category: e.category, message: e.message };
      }
      await persist(opts, journal);
      if (STOP_AFTER.has(entry.error!.category)) break;
    }
  }
  journal.status = journal.runs.some((r) => r.state === "succeeded") ? "in_progress" : journal.runs.some((r) => r.state === "planned") && !startPlanned ? "planned" : "failed";
  await persist(opts, journal);
}

async function recordSuccess(opts: ExaExecutionOptions, journal: DiscoveryRunJournal, entry: ProviderRunEntry, index: number, response: ExaSearchResponse) {
  const at = opts.now().toISOString();
  entry.providerRunId = response.requestId?.trim() ? response.requestId.trim().slice(0, 120) : `${journal.discoveryId}-q${index + 1}`;
  entry.state = "succeeded";
  entry.startedAt = entry.startRequestedAt;
  entry.finishedAt = at;
  entry.usageTotalUsd = response.costDollars?.total ?? null;
  entry.statusMessage = response.costDollars?.total === undefined ? "Exa did not report a cost for this request" : null;
  const file = `provider-response-q${index + 1}.json`;
  await writeJsonAtomic(join(opts.runDir, file), {
    recordType: "provider_response_snapshot",
    schemaVersion: 1,
    dataSource: journal.dataSource,
    source: EXA_SOURCE_LABEL,
    mode: "keyword",
    providerRunId: entry.providerRunId,
    datasetId: null,
    finishedAt: at,
    fetchedAt: at,
    itemLimit: entry.maxResults,
    truncated: false,
    items: snapshotItems(response, journal.request.retainRawResponses === true),
  });
  entry.snapshotFile = file;
  entry.itemCount = response.results.length;
  await persist(opts, journal);
}

/** Normalizes the saved snapshots of succeeded requests into a manifest. No network. */
export async function normalizeExaSavedRuns(runDir: string, journal: DiscoveryRunJournal, saved: SavedFingerprint): Promise<ExaManifestBuild> {
  const succeeded = journal.runs.filter((r) => r.state === "succeeded" && r.snapshotFile && r.providerRunId);
  if (succeeded.length === 0) throw new Error("No search request has succeeded with saved results");
  const rows: ExaQueryRows[] = [];
  for (const entry of succeeded) {
    const snapshot = await loadSnapshot(join(runDir, entry.snapshotFile!));
    if (snapshot.providerRunId !== entry.providerRunId || snapshot.dataSource !== journal.dataSource) {
      throw new Error(`Snapshot ${entry.snapshotFile} does not belong to request ${entry.providerRunId}`);
    }
    rows.push({ providerRunId: entry.providerRunId!, query: entry.queries[0], capturedAt: new Date(entry.finishedAt ?? snapshot.fetchedAt).toISOString(), items: snapshot.items });
  }
  return buildExaManifest({
    caseId: journal.caseId,
    referenceImageId: saved.reference.id,
    fingerprintId: saved.fingerprint.id,
    dataSource: journal.dataSource,
    capturedAt: new Date(succeeded.map((r) => r.finishedAt ?? journal.updatedAt).sort().at(-1)!).toISOString(),
    runs: succeeded.map((r) => ({ providerRunId: r.providerRunId!, status: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, chargedUsd: r.usageTotalUsd })),
    rows,
    queries: succeeded.flatMap((r) => r.queries),
    maxUniqueLeads: journal.request.maxResults,
    notes: `Automated discovery ${journal.discoveryId}: keyword search of the photo analysis's saved queries through Exa, an external web search index restricted to Alibaba.com product pages (not an official Alibaba.com API, not an Alibaba.com partner). Listings are as indexed and unverified; supplier details are not reported; prices are excerpts that may be stale.`,
  });
}
