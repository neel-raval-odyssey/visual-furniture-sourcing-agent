import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import type { FurnitureFeature } from "../domain";
import type { SourcingResult } from "../orchestration/assemble";
import { loadRunJournal, RunJournalError, type SourcingRunJournal } from "../orchestration/journal";
import { parseSourcingResult, SourcingResultError } from "../orchestration/result-schema";
import { EvidenceError, resolveReferenceImage } from "../shortlisting/evidence";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { loadVerificationRecords } from "../verification/openai/record";
import { localPaths } from "./local-access";

/**
 * Read-only access to saved sourcing records for the web experience. Every
 * file is validated with the existing schemas; callers receive presentation
 * data only (no local paths, raw model payloads or credentials).
 */

export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const RUN_ID = /^src-[0-9TZ-]+-[0-9a-f]{6}$/;
export const LISTING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A run whose journal says "running" but has not changed for this long is treated as interrupted. */
export const STALE_RUNNING_MS = 15 * 60 * 1000;

export type Paths = ReturnType<typeof localPaths>;

export interface RunSummary {
  caseId: string;
  runId: string;
  /** Journal status, with "interrupted" for a stale "running" journal. */
  status: SourcingRunJournal["status"] | "interrupted" | "invalid";
  createdAt: string | null;
  updatedAt: string | null;
  sourceKind: string | null;
  synthetic: boolean;
  result: { available: boolean; problem: string | null; counts: SourcingResult["counts"] | null; topProductId: string | null };
  problem: string | null;
}

export type Readiness = "results_available" | "ready_for_offline_run" | "no_candidates" | "not_identified" | "unavailable";

export interface ReferenceSummary {
  caseId: string;
  synthetic: boolean;
  referenceId: string | null;
  understanding: "furniture_identified" | "not_identified" | "error" | "missing" | "invalid";
  understandingNote: string | null;
  category: string | null;
  subtype: string | null;
  fingerprintId: string | null;
  fingerprintModel: string | null;
  photo: { available: boolean; url: string | null; problem: string | null };
  candidates: { state: "completed" | "not_started" | "missing" | "invalid"; count: number; acquisitionMethod: string | null };
  savedAssessments: number;
  runs: RunSummary[];
  readiness: Readiness;
}

export interface ReferenceDetail extends ReferenceSummary {
  fingerprint: {
    structure: FurnitureFeature[];
    appearance: FurnitureFeature[];
    distinctive: FurnitureFeature[];
    searchQueries: string[];
    createdAt: string;
    source: string;
  } | null;
}

const listDir = async (dir: string) => {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
};

export const referenceImageUrl = (caseId: string) => `/api/sourcing/evidence/reference/${caseId}`;
export const candidateImageUrl = (caseId: string, runId: string, listingId: string) =>
  `/api/sourcing/evidence/candidate/${caseId}/${runId}/${encodeURIComponent(listingId)}`;

export async function listRuns(paths: Paths, caseId: string, now = Date.now()): Promise<RunSummary[]> {
  if (!CASE_ID.test(caseId)) return [];
  const names = (await listDir(join(paths.sourcingRuns, caseId))).filter((n) => RUN_ID.test(n));
  const runs: RunSummary[] = [];
  for (const runId of names) {
    const runDir = join(paths.sourcingRuns, caseId, runId);
    const base: RunSummary = {
      caseId,
      runId,
      status: "invalid",
      createdAt: null,
      updatedAt: null,
      sourceKind: null,
      synthetic: false,
      result: { available: false, problem: null, counts: null, topProductId: null },
      problem: null,
    };
    let journal: SourcingRunJournal;
    try {
      journal = await loadRunJournal(runDir);
    } catch (error) {
      runs.push({ ...base, problem: error instanceof RunJournalError ? error.message : "run.json cannot be read" });
      continue;
    }
    const stale = journal.status === "running" && now - Date.parse(journal.updatedAt) > STALE_RUNNING_MS;
    const summary: RunSummary = {
      ...base,
      status: stale ? "interrupted" : journal.status,
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      sourceKind: journal.inputs.source.kind,
      synthetic: journal.inputs.synthetic,
    };
    const loaded = await readResult(runDir);
    if (loaded.result) {
      summary.result = {
        available: true,
        problem: null,
        counts: loaded.result.counts,
        topProductId: loaded.result.verified[0]?.marketplaceProductId ?? null,
      };
      summary.synthetic = loaded.result.synthetic;
    } else {
      summary.result.problem = loaded.problem;
    }
    runs.push(summary);
  }
  return runs.sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
}

async function readResult(runDir: string): Promise<{ result: SourcingResult | null; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(join(runDir, "result.json"), "utf8");
  } catch {
    return { result: null, problem: null };
  }
  try {
    return { result: parseSourcingResult(JSON.parse(text)), problem: null };
  } catch (error) {
    return { result: null, problem: error instanceof SourcingResultError ? error.message : "result.json is not valid JSON" };
  }
}

async function loadSaved(paths: Paths, caseId: string): Promise<{ saved: SavedFingerprint | null; state: ReferenceSummary["understanding"]; note: string | null }> {
  try {
    return { saved: await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId), state: "furniture_identified", note: null };
  } catch (error) {
    if (!(error instanceof SavedRunError)) throw error;
    const state = error.problem === "missing_record" ? "missing" : error.problem === "not_identified" ? "not_identified" : error.problem === "model_error" ? "error" : "invalid";
    return { saved: null, state, note: error.message };
  }
}

async function candidateState(paths: Paths, caseId: string): Promise<ReferenceSummary["candidates"]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(paths.candidates, `${caseId}.json`), "utf8"));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid", count: 0, acquisitionMethod: null };
  }
  const parsed = candidateManifestSchema.safeParse(raw);
  if (!parsed.success) return { state: "invalid", count: 0, acquisitionMethod: null };
  return { state: parsed.data.capture.status, count: parsed.data.candidates.length, acquisitionMethod: parsed.data.capture.method };
}

async function summarize(paths: Paths, caseId: string): Promise<ReferenceDetail> {
  const { saved, state, note } = await loadSaved(paths, caseId);
  const runs = await listRuns(paths, caseId);
  const latestResult = runs.find((r) => r.result.available);
  let photo: ReferenceSummary["photo"] = { available: false, url: null, problem: saved ? null : "no saved reference record" };
  if (saved) {
    try {
      await resolveReferenceImage(paths.imagesMap, saved);
      photo = { available: true, url: referenceImageUrl(caseId), problem: null };
    } catch (error) {
      photo = { available: false, url: null, problem: error instanceof EvidenceError ? error.message : "reference photo unavailable" };
    }
  }
  const candidates = await candidateState(paths, caseId);
  const records = await loadVerificationRecords(paths.verifications, caseId);
  const fp = saved?.fingerprint;
  const synthetic = (fp?.source.dataSource ?? (latestResult?.synthetic ? "mock" : "live")) === "mock";
  const readiness: Readiness = latestResult
    ? "results_available"
    : state !== "furniture_identified"
      ? state === "missing" ? "unavailable" : "not_identified"
      : candidates.state === "completed"
        ? "ready_for_offline_run"
        : "no_candidates";
  return {
    caseId,
    synthetic,
    referenceId: saved?.reference.id ?? null,
    understanding: state,
    understandingNote: note,
    category: fp?.category ?? null,
    subtype: fp?.subtype ?? null,
    fingerprintId: fp?.id ?? null,
    fingerprintModel: fp ? (fp.source.modelId ?? fp.source.kind) : null,
    photo,
    candidates,
    savedAssessments: records.records.filter((r) => r.record.status === "succeeded").length,
    runs,
    readiness,
    fingerprint: fp
      ? {
          structure: fp.structure,
          appearance: fp.appearance,
          distinctive: fp.distinctiveFeatures,
          searchQueries: fp.searchQueries,
          createdAt: fp.createdAt,
          source: `${fp.source.kind}${fp.source.modelId ? ` · ${fp.source.modelId}` : ""} · ${fp.source.dataSource}`,
        }
      : null,
  };
}

/** References: saved Luna runs, plus any case that only has sourcing runs (e.g. synthetic demos). */
export async function listReferences(paths: Paths): Promise<ReferenceSummary[]> {
  const fromPredictions = (await listDir(paths.predictions)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  const fromRuns = await listDir(paths.sourcingRuns);
  const ids = [...new Set([...fromPredictions, ...fromRuns])].filter((id) => CASE_ID.test(id));
  const all = await Promise.all(ids.map((id) => summarize(paths, id)));
  const order: Record<Readiness, number> = { results_available: 0, ready_for_offline_run: 1, no_candidates: 2, not_identified: 3, unavailable: 4 };
  return all
    .map((detail): ReferenceSummary => {
      const summary: ReferenceSummary & { fingerprint?: unknown } = { ...detail };
      delete summary.fingerprint;
      return summary;
    })
    .sort((a, b) => Number(a.synthetic) - Number(b.synthetic) || order[a.readiness] - order[b.readiness] || (a.caseId < b.caseId ? -1 : 1));
}

export async function getReference(paths: Paths, caseId: string): Promise<ReferenceDetail | null> {
  if (!CASE_ID.test(caseId)) return null;
  const detail = await summarize(paths, caseId);
  if (detail.understanding === "missing" && detail.runs.length === 0) return null;
  return detail;
}

export interface RunDetail {
  summary: RunSummary;
  stages: { name: string; state: string; startedAt: string | null; finishedAt: string | null; message: string | null }[];
  resumedAt: string[];
  result: SourcingResult | null;
  resultProblem: string | null;
}

export async function getRun(paths: Paths, caseId: string, runId: string): Promise<RunDetail | null> {
  if (!CASE_ID.test(caseId) || !RUN_ID.test(runId)) return null;
  const summary = (await listRuns(paths, caseId)).find((r) => r.runId === runId);
  if (!summary) return null;
  const runDir = join(paths.sourcingRuns, caseId, runId);
  let journal: SourcingRunJournal | null = null;
  try {
    journal = await loadRunJournal(runDir);
  } catch {
    journal = null;
  }
  const loaded = await readResult(runDir);
  return {
    summary,
    stages: journal ? Object.entries(journal.stages).map(([name, s]) => ({ name, state: s.state, startedAt: s.startedAt, finishedAt: s.finishedAt, message: s.message })) : [],
    resumedAt: journal?.resumedAt ?? [],
    result: loaded.result,
    resultProblem: loaded.problem,
  };
}

/** Where a run's candidate evidence lives (from its own journal, never from a request). */
export async function runManifestDir(paths: Paths, caseId: string, runId: string): Promise<string | null> {
  if (!CASE_ID.test(caseId) || !RUN_ID.test(runId)) return null;
  try {
    const journal = await loadRunJournal(join(paths.sourcingRuns, caseId, runId));
    const source = journal.inputs.source;
    const resolveStored = (p: string) => (p.startsWith("/") ? p : join(paths.root, p));
    if (source.kind === "curated") return join(resolveStored(source.manifest), "..");
    if (source.kind === "provider-run") return resolveStored(source.discoveryRun);
    return null;
  } catch {
    return null;
  }
}
