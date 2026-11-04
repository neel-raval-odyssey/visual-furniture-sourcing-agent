import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { candidateManifestSchema } from "../../discovery/curated/manifest";
import { loadJournal, saveJournal, type DiscoveryRunJournal } from "../../discovery/providers/apify/run-journal";
import {
  CATALOGUE_LIMITS,
  catalogueInputKey,
  loadCatalogue,
  runCatalogueSearch,
  type CatalogueMatch,
  type CatalogueSearchSummary,
  type CatalogueSource,
} from "../../discovery/providers/local-catalogue/catalogue";
import { loadRunJournal } from "../../orchestration/journal";
import type { ImageSimilarityRunner } from "../../shortlisting/embedding-client";
import { loadSavedFingerprint, type SavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { withFileLock } from "../analysis/register";
import { CASE_ID, getReference, type Paths } from "../data";
import { startOfflineRun } from "../offline-run";
import { DISCOVERY_ID } from "./automatic-search";

/**
 * "Search saved catalogue" for an analysed photo: one action that searches the
 * product records already saved on this computer and, when any selected
 * product has a photo, compares them with the photo locally (SigLIP 2) through
 * the normal sourcing run, which reuses compatible saved Sol assessments.
 * Nothing leaves the computer: no marketplace search, no image download, no
 * paid AI request.
 *
 * Repeating the action with unchanged inputs (same saved records, same
 * analysis) returns the earlier search and its comparison instead of running
 * either again, so a double click or a repeated request never recomputes.
 */

export interface CatalogueSearchDeps {
  /** Local SigLIP 2 runner; defaults to the vision service. null: compare only with a reusable saved shortlist. */
  runner?: ImageSimilarityRunner | null;
  now?: () => Date;
}

export type CatalogueStartOutcome =
  | {
      ok: true;
      discoveryId: string;
      reusedSearch: boolean;
      products: number;
      withPhoto: number;
      /** The comparison of this product set; null when nothing could be compared. */
      runId: string | null;
      reusedRun: boolean;
      runStatus: string | null;
    }
  | { ok: false; status: 400 | 404 | 409; code: "invalid_request" | "not_found" | "not_eligible" | "already_running" | "failed"; message: string };

export function catalogueSources(paths: Paths): CatalogueSource[] {
  return [{ dir: paths.candidates, display: relative(paths.root, paths.candidates) || "evals/local/candidates" }];
}

async function catalogueJournals(paths: Paths, caseId: string): Promise<{ dir: string; journal: DiscoveryRunJournal }[]> {
  const caseDir = join(paths.discovery, caseId);
  const names = (await readdir(caseDir).catch(() => [] as string[])).filter((n) => DISCOVERY_ID.test(n)).sort();
  const out: { dir: string; journal: DiscoveryRunJournal }[] = [];
  for (const name of names) {
    const journal = await loadJournal(join(caseDir, name)).catch(() => null);
    if (journal && journal.caseId === caseId && journal.provider.service === "local_catalogue") out.push({ dir: join(caseDir, name), journal });
  }
  // Oldest first by creation time (ids share a one-second resolution).
  return out.sort((a, b) => (a.journal.createdAt < b.journal.createdAt ? -1 : a.journal.createdAt > b.journal.createdAt ? 1 : 0));
}

const readSummary = async (dir: string, journal: DiscoveryRunJournal): Promise<CatalogueSearchSummary | null> => {
  if (!journal.summaryFile) return null;
  const s = (await readFile(join(dir, journal.summaryFile), "utf8").then(JSON.parse).catch(() => null)) as CatalogueSearchSummary | null;
  return s?.recordType === "catalogue_search_summary" ? s : null;
};

const fileSha = async (path: string) => {
  const bytes = await readFile(path).catch(() => null);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
};

/** The latest finished comparison of exactly this product set (by manifest hash), if any. */
async function comparisonOf(paths: Paths, caseId: string, manifestSha256: string): Promise<{ runId: string; status: string } | null> {
  const dir = join(paths.sourcingRuns, caseId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith("src-")).sort().reverse();
  for (const name of names) {
    const j = await loadRunJournal(join(dir, name)).catch(() => null);
    if (j && j.resolved.manifestSha256 === manifestSha256 && (j.status === "completed" || j.status === "partial")) return { runId: j.runId, status: j.status };
  }
  return null;
}

export async function startCatalogueSearch(paths: Paths, caseId: string, deps: CatalogueSearchDeps = {}): Promise<CatalogueStartOutcome> {
  if (!CASE_ID.test(caseId)) return { ok: false, status: 400, code: "invalid_request", message: "Invalid case" };
  const reference = await getReference(paths, caseId);
  if (!reference) return { ok: false, status: 404, code: "not_found", message: "No such photo" };
  let saved: SavedFingerprint;
  try {
    saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  } catch {
    return { ok: false, status: 409, code: "not_eligible", message: "This photo has no saved analysis to search with." };
  }
  if (saved.fingerprint.source.dataSource === "mock" || reference.synthetic) return { ok: false, status: 409, code: "not_eligible", message: "Synthetic analyses are not searched." };
  const now = deps.now ?? (() => new Date());
  await mkdir(join(paths.discovery, caseId), { recursive: true });

  const search = await withFileLock(join(paths.discovery, caseId, "catalogue"), async () => {
    const load = await loadCatalogue(catalogueSources(paths), "live");
    const key = catalogueInputKey(load, saved, CATALOGUE_LIMITS.maxResults);
    for (const { dir, journal } of (await catalogueJournals(paths, caseId)).reverse()) {
      // An interrupted earlier search (no summary) is settled as failed; it made no external request, so a new one is safe.
      if (journal.status === "in_progress" && !journal.summaryFile) {
        journal.status = "failed";
        journal.runs[0].state = "failed";
        journal.runs[0].error = { category: "interrupted", message: "The catalogue search stopped before it finished." };
        await saveJournal(dir, journal);
        continue;
      }
      const summary = await readSummary(dir, journal);
      if (journal.status === "completed" && summary?.inputKey === key && journal.manifestFile) {
        return { discoveryId: journal.discoveryId, runDir: dir, summary, reused: true };
      }
    }
    const done = await runCatalogueSearch({ discoveryDir: paths.discovery, caseId, saved, sources: catalogueSources(paths), now, load });
    return { discoveryId: done.discoveryId, runDir: done.runDir, summary: done.summary, reused: false };
  });

  const base = { ok: true as const, discoveryId: search.discoveryId, reusedSearch: search.reused, products: search.summary.counts.selected, withPhoto: search.summary.counts.withLocalImage };
  if (base.withPhoto === 0) return { ...base, runId: null, reusedRun: false, runStatus: null };
  const manifestSha = await fileSha(join(search.runDir, search.summary.manifest));
  const earlier = manifestSha ? await comparisonOf(paths, caseId, manifestSha) : null;
  if (earlier) return { ...base, runId: earlier.runId, reusedRun: true, runStatus: earlier.status };
  const run = await startOfflineRun(paths, caseId, deps.runner === undefined ? {} : { runner: deps.runner, now: deps.now }, { kind: "automatic", discoveryId: search.discoveryId });
  if (!run.ok) return { ok: false, status: run.status === 404 ? 404 : 409, code: run.code === "already_running" ? "already_running" : "failed", message: run.message };
  return { ...base, runId: run.runId, reusedRun: false, runStatus: run.status };
}

export interface CatalogueSearchView {
  discoveryId: string;
  createdAt: string;
  status: DiscoveryRunJournal["status"];
  summary: CatalogueSearchSummary | null;
  manifestSha256: string | null;
  products: {
    index: number;
    title: string;
    listingUrl: string;
    hasPhoto: boolean;
    supplierName: string | null;
    price: { min: number; max?: number | null; currency?: string | null; unit?: string | null } | null;
    minimumOrder: { quantity: number; unit?: string | null } | null;
    /** Where the record came from: the saved collection (case) it was recorded for. */
    originCase: string | null;
    match: string | null;
    photoProblem: string | null;
  }[];
}

/** Saved catalogue searches for a case, newest first. Reads files only. */
export async function listCatalogueSearches(paths: Paths, caseId: string): Promise<CatalogueSearchView[]> {
  if (!CASE_ID.test(caseId)) return [];
  const views: CatalogueSearchView[] = [];
  for (const { dir, journal } of await catalogueJournals(paths, caseId)) {
    const summary = await readSummary(dir, journal);
    let products: CatalogueSearchView["products"] = [];
    let manifestSha256: string | null = null;
    if (journal.manifestFile) {
      const bytes = await readFile(join(dir, journal.manifestFile)).catch(() => null);
      const parsed = bytes ? candidateManifestSchema.safeParse(JSON.parse(bytes.toString("utf8"))) : null;
      const snapshot = journal.runs[0]?.snapshotFile ? ((await readFile(join(dir, journal.runs[0].snapshotFile), "utf8").then(JSON.parse).catch(() => null)) as { items?: CatalogueMatch[] } | null) : null;
      const byUrl = new Map((snapshot?.items ?? []).filter((x) => x.decision === "selected").map((x) => [x.listingUrl, x]));
      if (bytes && parsed?.success) {
        manifestSha256 = createHash("sha256").update(bytes).digest("hex");
        products = parsed.data.candidates.map((c, index) => {
          const m = byUrl.get(c.listingUrl);
          return {
            index,
            title: c.title,
            listingUrl: c.listingUrl,
            hasPhoto: c.images.some((i) => "localPath" in i),
            supplierName: c.supplierRef ? (parsed.data.suppliers.find((s) => s.ref === c.supplierRef)?.name ?? null) : null,
            price: c.price ?? null,
            minimumOrder: c.minimumOrder ?? null,
            originCase: m?.origin.caseId ?? null,
            match: m?.reason ?? null,
            photoProblem: m?.photo?.status === "unusable" ? m.photo.attempts.map((a) => a.problem).join("; ") : m?.photo?.status === "none_saved" ? "no photo saved" : null,
          };
        });
      }
    }
    views.push({ discoveryId: journal.discoveryId, createdAt: journal.createdAt, status: journal.status, summary, manifestSha256, products });
  }
  return views.reverse();
}
