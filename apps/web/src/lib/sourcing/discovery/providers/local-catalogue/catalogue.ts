import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ImageInputError } from "../../../image-input/image-content";
import { inspectImage } from "../../../image-input/inspect";
import { prioritizeImages } from "../../../shortlisting/evidence";
import type { SavedFingerprint } from "../../../understanding/saved/saved-fingerprint";
import { summarizeIssues } from "../../../validation/issues";
import { canonicalUrl } from "../../curated/marketplace-urls";
import { candidateIdentity, candidateManifestSchema, type CandidateManifest, type ManifestCandidate, type ManifestSupplier } from "../../curated/manifest";
import { JournalError, loadSnapshot, newDiscoveryId, saveJournal, writeJsonAtomic, type DiscoveryRunJournal } from "../apify/run-journal";
import { classifyProduct, compareTypes, humanType, matchedTerms, referenceTerms, referenceType, type FurnitureType, type TypeMatch } from "./furniture-types";

/**
 * Local catalogue: a searchable index of product records already saved on this
 * computer (validated, completed candidate manifests in evals/local/candidates).
 * A search selects the records relevant to one analysed photo — by furniture
 * type from the saved Luna fingerprint, then by shared descriptive words — and
 * saves them as a separate candidate set in the same folder and format as any
 * other discovery run (evals/local/discovery/<case>/<search id>/): run.json, a
 * snapshot of every decision with its provenance, a provider_api manifest, the
 * selected products' photos copied under their SHA-256, and a summary. SigLIP
 * 2 does the visual ranking later through the normal sourcing run.
 *
 * Nothing is invented: titles, suppliers, prices and photos are copied from the
 * original records, each with its originating manifest and index. No network
 * request of any kind is made, and the original records are only read.
 */

export const CATALOGUE_PROVIDER_ID = "local-catalogue";
export const CATALOGUE_SOURCE_LABEL = "Product records saved on this computer (evals/local/candidates)";
export const CATALOGUE_LIMITS = { maxResults: 20, maxImageBytes: 15 * 1024 * 1024 } as const;
/** Changes when the selection rules change, so an earlier search is not reused for different rules. */
export const CATALOGUE_RULES_VERSION = "2026-11-03.1";
export const CATALOGUE_SNAPSHOT = "catalogue-matches.json";
export const CATALOGUE_SUMMARY = "import-summary.json";

const MANIFEST_FILE = /^[a-z0-9][a-z0-9-]*\.json$/;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface CatalogueSource {
  /** Folder whose top-level <case>.json files are completed candidate manifests. */
  dir: string;
  /** Repo-relative label for records and messages. */
  display: string;
}

export interface CatalogueManifest {
  file: string;
  dir: string;
  caseId: string;
  sha256: string;
  manifest: CandidateManifest;
}

export interface CatalogueLoad {
  manifests: CatalogueManifest[];
  skipped: { manifest: string; reason: string }[];
}

/** Reads every saved manifest; invalid, unfinished or differently-sourced ones are skipped with a reason. */
export async function loadCatalogue(sources: readonly CatalogueSource[], dataSource: "live" | "mock"): Promise<CatalogueLoad> {
  const out: CatalogueLoad = { manifests: [], skipped: [] };
  for (const source of sources) {
    const names = (await readdir(source.dir).catch(() => [] as string[])).filter((n) => MANIFEST_FILE.test(n)).sort();
    for (const name of names) {
      const file = `${source.display}/${name}`;
      let bytes: Buffer;
      try {
        const info = await lstat(join(source.dir, name));
        if (!info.isFile()) {
          out.skipped.push({ manifest: file, reason: "not a regular file" });
          continue;
        }
        bytes = await readFile(join(source.dir, name));
      } catch {
        out.skipped.push({ manifest: file, reason: "cannot be read" });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch {
        out.skipped.push({ manifest: file, reason: "not valid JSON" });
        continue;
      }
      const parsed = candidateManifestSchema.safeParse(raw);
      if (!parsed.success) {
        out.skipped.push({ manifest: file, reason: `invalid manifest: ${summarizeIssues(parsed.error)}` });
        continue;
      }
      const m = parsed.data;
      if (m.dataSource !== dataSource) {
        out.skipped.push({ manifest: file, reason: dataSource === "live" ? "synthetic test records are never mixed with genuine ones" : "genuine records are not used for synthetic searches" });
        continue;
      }
      if (m.capture.status !== "completed") {
        out.skipped.push({ manifest: file, reason: "not filled in yet" });
        continue;
      }
      if (m.capture.provider?.access === "local_catalogue") {
        out.skipped.push({ manifest: file, reason: "a catalogue search result, not an original record" });
        continue;
      }
      out.manifests.push({ file, dir: source.dir, caseId: m.caseId, sha256: sha256(bytes), manifest: m });
    }
  }
  return out;
}

export type CatalogueDecision = "selected" | "duplicate" | "different_type" | "unrecognised_type" | "over_limit";

export interface CatalogueMatch {
  /** Listing identity (marketplace product id, else canonical URL). */
  identity: string;
  origin: { manifest: string; manifestSha256: string; caseId: string; index: number; capturedAt: string; foundWith: string | null };
  title: string;
  listingUrl: string;
  productType: FurnitureType | null;
  typeFrom: "title" | "category" | null;
  typePhrase: string | null;
  typeMatch: TypeMatch | null;
  matchedTerms: string[];
  decision: CatalogueDecision;
  reason: string;
  /** 1-based position in the selected set. */
  rank: number | null;
  /** For a duplicate: the origin of the record kept instead. */
  keptFrom: string | null;
  photo:
    | { status: "copied"; originalPath: string; sha256: string; localPath: string; mimeType: string; width: number; height: number }
    | { status: "none_saved" }
    | { status: "unusable"; attempts: { originalPath: string; problem: string }[] }
    | null;
}

export interface CatalogueSelection {
  reference: { furnitureType: FurnitureType | null; phrase: string | null; from: string | null; terms: string[] };
  matches: CatalogueMatch[];
}

const hasLocal = (c: ManifestCandidate) => c.images.some((i) => "localPath" in i);

/** Pure selection over loaded records (no file access). */
export function selectFromCatalogue(load: CatalogueLoad, saved: SavedFingerprint, maxResults: number): CatalogueSelection {
  const fp = saved.fingerprint;
  const ref = referenceType(fp);
  const terms = referenceTerms(fp);
  const matches: CatalogueMatch[] = [];
  for (const m of load.manifests) {
    m.manifest.candidates.forEach((c, index) => {
      const cls = classifyProduct(c);
      const typeMatch = cls && ref ? compareTypes(ref.type, cls.type) : null;
      matches.push({
        identity: candidateIdentity(c),
        origin: { manifest: m.file, manifestSha256: m.sha256, caseId: m.caseId, index, capturedAt: c.capturedAt ?? m.manifest.capture.capturedAt!, foundWith: c.foundWith ?? m.manifest.capture.tools[0] ?? null },
        title: c.title,
        listingUrl: c.listingUrl,
        productType: cls?.type ?? null,
        typeFrom: cls?.from ?? null,
        typePhrase: cls?.phrase ?? null,
        typeMatch,
        matchedTerms: matchedTerms(c.title, terms),
        decision: !ref || !cls ? "unrecognised_type" : typeMatch === "different_type" ? "different_type" : "selected",
        reason: !ref
          ? "the furniture type of your photo could not be determined from its saved analysis"
          : !cls
            ? "the product's furniture type is not recognised from its title or category"
            : typeMatch === "different_type"
              ? `a ${humanType(cls.type)}, not a ${humanType(ref.type)}`
              : typeMatch === "same_type"
                ? `same furniture type (${humanType(cls.type)})`
                : `related furniture type (${humanType(cls.type)} for a ${humanType(ref.type)})`,
        rank: null,
        keptFrom: null,
        photo: null,
      });
    });
  }
  // One record per product: the one with a saved photo, then the most recently captured, then catalogue order.
  const byIdentity = new Map<string, CatalogueMatch[]>();
  for (const x of matches) byIdentity.set(x.identity, [...(byIdentity.get(x.identity) ?? []), x]);
  const candidateOf = (x: CatalogueMatch) => load.manifests.find((m) => m.file === x.origin.manifest)!.manifest.candidates[x.origin.index];
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const kept = [...group].sort((a, b) => Number(hasLocal(candidateOf(b))) - Number(hasLocal(candidateOf(a))) || (a.origin.capturedAt < b.origin.capturedAt ? 1 : a.origin.capturedAt > b.origin.capturedAt ? -1 : 0))[0];
    for (const x of group) {
      if (x === kept) continue;
      x.decision = "duplicate";
      x.reason = "the same product is saved more than once; one record is used";
      x.keptFrom = `${kept.origin.manifest}#${kept.origin.index}`;
    }
  }
  const tier = (x: CatalogueMatch) => (x.typeMatch === "same_type" ? 0 : 1);
  const selected = matches
    .filter((x) => x.decision === "selected")
    .sort((a, b) => tier(a) - tier(b) || b.matchedTerms.length - a.matchedTerms.length || (a.origin.manifest < b.origin.manifest ? -1 : a.origin.manifest > b.origin.manifest ? 1 : a.origin.index - b.origin.index));
  selected.forEach((x, i) => {
    if (i < maxResults) x.rank = i + 1;
    else {
      x.decision = "over_limit";
      x.reason = `beyond the ${maxResults}-product limit for one search`;
    }
  });
  return { reference: { furnitureType: ref?.type ?? null, phrase: ref?.phrase ?? null, from: ref?.from ?? null, terms }, matches };
}

/** The search inputs: same key, same result. */
export function catalogueInputKey(load: CatalogueLoad, saved: SavedFingerprint, maxResults: number): string {
  return sha256(
    JSON.stringify({
      rules: CATALOGUE_RULES_VERSION,
      maxResults,
      fingerprintId: saved.fingerprint.id,
      reference: saved.record.image.sha256,
      manifests: load.manifests.map((m) => [m.file, m.sha256]),
      skipped: load.skipped.map((s) => s.manifest),
    }),
  );
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Reads one saved photo confined to its manifest's folder (no symlinks, no escapes) and checks it is a real PNG/JPEG/WebP. */
async function readSavedPhoto(dir: string, localPath: string): Promise<{ ok: true; bytes: Uint8Array; mimeType: string; width: number; height: number } | { ok: false; problem: string }> {
  const lexical = resolve(dir, localPath);
  if (!inside(resolve(dir), lexical)) return { ok: false, problem: "outside its records folder" };
  let info;
  try {
    info = await lstat(lexical);
  } catch {
    return { ok: false, problem: "file missing" };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, problem: "not a regular file" };
  if (!inside(await realpath(dir), await realpath(lexical))) return { ok: false, problem: "outside its records folder" };
  if (info.size > CATALOGUE_LIMITS.maxImageBytes) return { ok: false, problem: "too large" };
  const bytes = new Uint8Array(await readFile(lexical));
  try {
    const inspected = inspectImage(bytes);
    return { ok: true, bytes, mimeType: inspected.mimeType, width: inspected.width, height: inspected.height };
  } catch (error) {
    if (error instanceof ImageInputError) return { ok: false, problem: error.code === "empty" ? "empty file" : error.code === "too_large" ? "too large" : "not a readable PNG, JPEG or WebP image" };
    throw error;
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Copies a product's first usable saved photo into the search folder, named by its SHA-256. Never overwrites. */
async function copyPhoto(runDir: string, caseId: string, origin: CatalogueManifest, c: ManifestCandidate): Promise<NonNullable<CatalogueMatch["photo"]>> {
  const local = prioritizeImages(c.images).filter((i): i is Extract<typeof i, { localPath: string }> => "localPath" in i);
  if (!local.length) return { status: "none_saved" };
  const attempts: { originalPath: string; problem: string }[] = [];
  for (const img of local) {
    const originalPath = `${origin.file.replace(/\/[^/]+$/, "")}/${img.localPath}`;
    const read = await readSavedPhoto(origin.dir, img.localPath);
    if (!read.ok) {
      attempts.push({ originalPath, problem: read.problem });
      continue;
    }
    const sha = sha256(read.bytes);
    const name = `${sha.slice(0, 24)}.${EXT[read.mimeType]}`;
    // Built without path.join so the bundler does not trace the whole project.
    const dest = `${runDir}/${caseId}/${name}`;
    const existing = await readFile(dest).catch(() => null);
    if (existing && sha256(existing) !== sha) throw new Error(`refusing to overwrite ${name}`);
    if (!existing) await writeFile(dest, read.bytes, { flag: "wx" });
    return { status: "copied", originalPath, sha256: sha, localPath: `${caseId}/${name}`, mimeType: read.mimeType, width: read.width, height: read.height };
  }
  return { status: "unusable", attempts };
}

export interface CatalogueSearchSummary {
  recordType: "catalogue_search_summary";
  schemaVersion: 1;
  discoveryId: string;
  inputKey: string;
  rulesVersion: string;
  reference: CatalogueSelection["reference"];
  catalogue: { manifests: { manifest: string; caseId: string; products: number; sha256: string }[]; skipped: CatalogueLoad["skipped"] };
  counts: {
    considered: number;
    duplicates: number;
    sameType: number;
    relatedType: number;
    differentType: number;
    unrecognisedType: number;
    overLimit: number;
    selected: number;
    withLocalImage: number;
    photoProblems: number;
    withSupplier: number;
    withPrice: number;
    withMinimumOrder: number;
  };
  photoProblems: { listingUrl: string; attempts: { originalPath: string; problem: string }[] }[];
  manifest: string;
  /** Always 0: a catalogue search reads local files only. */
  externalRequests: 0;
}

export interface CatalogueSearchInput {
  discoveryDir: string;
  caseId: string;
  saved: SavedFingerprint;
  sources: readonly CatalogueSource[];
  maxResults?: number;
  now: () => Date;
  /** A load already made for the input key (avoids reading twice). */
  load?: CatalogueLoad;
}

/** Runs one catalogue search and saves it as a discovery run. Local files only. */
export async function runCatalogueSearch(input: CatalogueSearchInput): Promise<{ discoveryId: string; runDir: string; journal: DiscoveryRunJournal; summary: CatalogueSearchSummary; manifest: CandidateManifest }> {
  const maxResults = Math.min(input.maxResults ?? CATALOGUE_LIMITS.maxResults, CATALOGUE_LIMITS.maxResults);
  const { saved, caseId } = input;
  const dataSource = saved.fingerprint.source.dataSource === "mock" ? "mock" : "live";
  const started = input.now();
  const discoveryId = newDiscoveryId(started);
  const runDir = join(input.discoveryDir, caseId, discoveryId);
  const runId = `${discoveryId}-catalogue`;
  await mkdir(join(runDir, caseId), { recursive: true });
  const journal: DiscoveryRunJournal = {
    recordType: "marketplace_discovery_run",
    schemaVersion: 1,
    discoveryId,
    caseId,
    dataSource,
    createdAt: started.toISOString(),
    updatedAt: started.toISOString(),
    status: "in_progress",
    provider: { providerId: CATALOGUE_PROVIDER_ID, service: "local_catalogue", source: CATALOGUE_SOURCE_LABEL, access: "local_catalogue" },
    reference: { referenceImageId: saved.reference.id, fingerprintId: saved.fingerprint.id, sha256: saved.record.image.sha256 },
    request: { mode: "keyword", maxResults, costCapUsd: 0, imageTransport: null, downloadImages: false, imagesPerListing: 1 },
    runs: [
      {
        mode: "keyword",
        state: "running",
        maxResults,
        costCapUsd: 0,
        estimatedUsd: 0,
        queries: [],
        providerRunId: runId,
        datasetId: null,
        startRequestedAt: started.toISOString(),
        startedAt: started.toISOString(),
        finishedAt: null,
        statusMessage: "searching saved product records",
        chargedEventCounts: null,
        usageTotalUsd: 0,
        error: null,
        snapshotFile: null,
        itemCount: null,
      },
    ],
    storageUpload: null,
    manifestFile: null,
    summaryFile: null,
  };
  await saveJournal(runDir, journal);

  const load = input.load ?? (await loadCatalogue(input.sources, dataSource));
  const selection = selectFromCatalogue(load, saved, maxResults);
  const byFile = new Map(load.manifests.map((m) => [m.file, m]));
  const chosen = selection.matches.filter((x) => x.decision === "selected").sort((a, b) => a.rank! - b.rank!);
  for (const x of chosen) {
    const origin = byFile.get(x.origin.manifest)!;
    x.photo = await copyPhoto(runDir, caseId, origin, origin.manifest.candidates[x.origin.index]);
  }

  // The manifest: original fields copied as recorded, photos replaced by the verified copies, provenance in notes.
  const finished = input.now().toISOString();
  const suppliers: ManifestSupplier[] = [];
  const supplierRefFor = new Map<string, string>();
  const candidates: ManifestCandidate[] = chosen.map((x) => {
    const origin = byFile.get(x.origin.manifest)!;
    const c = origin.manifest.candidates[x.origin.index];
    let supplierRef: string | null = null;
    const s = c.supplierRef ? origin.manifest.suppliers.find((y) => y.ref === c.supplierRef) : undefined;
    if (s) {
      const key = s.profileUrl ? `url:${canonicalUrl(s.profileUrl)}` : `ref:${x.origin.manifest}#${s.ref}`;
      supplierRef = supplierRefFor.get(key) ?? null;
      if (!supplierRef) {
        supplierRef = `supplier-${suppliers.length + 1}`;
        supplierRefFor.set(key, supplierRef);
        suppliers.push({ ...s, ref: supplierRef });
      }
    }
    const photo = x.photo?.status === "copied" ? x.photo : null;
    const remote = c.images.filter((i) => "url" in i).map((i) => (photo && i.role === "primary" ? { ...i, role: "source" } : i));
    return {
      listingUrl: c.listingUrl,
      ...(c.marketplaceProductId ? { marketplaceProductId: c.marketplaceProductId } : {}),
      title: c.title,
      ...(c.category ? { category: c.category } : {}),
      images: [...(photo ? [{ localPath: photo.localPath, role: "primary", mimeType: photo.mimeType as "image/png" | "image/jpeg" | "image/webp" }] : []), ...remote],
      ...(c.attributes ? { attributes: c.attributes } : {}),
      ...(c.price ? { price: c.price } : {}),
      ...(c.minimumOrder ? { minimumOrder: c.minimumOrder } : {}),
      ...(supplierRef ? { supplierRef } : {}),
      capturedAt: x.origin.capturedAt,
      ...(x.origin.foundWith ? { foundWith: x.origin.foundWith as ManifestCandidate["foundWith"] } : {}),
      discoverySources: [{ mode: "keyword", providerRunId: runId, query: selection.reference.phrase, position: x.rank!, sponsored: null }],
      ...(c.priceTiers ? { priceTiers: c.priceTiers } : {}),
      notes: [`From saved records ${x.origin.manifest} (product ${x.origin.index + 1}), captured ${x.origin.capturedAt.slice(0, 10)}.`, x.reason, c.notes ?? null].filter(Boolean).join(" "),
    } as ManifestCandidate;
  });
  const manifest = candidateManifestSchema.parse({
    manifestType: "alibaba_candidate_manifest",
    schemaVersion: 1,
    dataSource,
    caseId,
    referenceImageId: saved.reference.id,
    fingerprintId: saved.fingerprint.id,
    capture: {
      status: "completed",
      method: "provider_api",
      capturedAt: finished,
      tools: ["provider_catalogue_search"],
      queriesTyped: selection.reference.phrase ? [selection.reference.phrase] : [],
      notes: `Selected from ${load.manifests.length} saved product record file(s) on this computer by furniture type; no marketplace request. Each product keeps its original capture date and source.`,
      provider: {
        providerId: CATALOGUE_PROVIDER_ID,
        service: "local_catalogue",
        source: CATALOGUE_SOURCE_LABEL,
        access: "local_catalogue",
        runs: [{ mode: "keyword", providerRunId: runId, status: "succeeded", startedAt: started.toISOString(), finishedAt: finished, chargedUsd: 0 }],
      },
    },
    suppliers,
    candidates,
  });

  const count = (d: CatalogueDecision) => selection.matches.filter((x) => x.decision === d).length;
  const typed = (t: TypeMatch) => selection.matches.filter((x) => x.typeMatch === t && x.decision !== "duplicate").length;
  const summary: CatalogueSearchSummary = {
    recordType: "catalogue_search_summary",
    schemaVersion: 1,
    discoveryId,
    inputKey: catalogueInputKey(load, saved, maxResults),
    rulesVersion: CATALOGUE_RULES_VERSION,
    reference: selection.reference,
    catalogue: { manifests: load.manifests.map((m) => ({ manifest: m.file, caseId: m.caseId, products: m.manifest.candidates.length, sha256: m.sha256 })), skipped: load.skipped },
    counts: {
      considered: selection.matches.length,
      duplicates: count("duplicate"),
      sameType: typed("same_type"),
      relatedType: typed("related_type"),
      differentType: count("different_type"),
      unrecognisedType: count("unrecognised_type"),
      overLimit: count("over_limit"),
      selected: chosen.length,
      withLocalImage: chosen.filter((x) => x.photo?.status === "copied").length,
      photoProblems: chosen.filter((x) => x.photo?.status === "unusable").length,
      withSupplier: candidates.filter((c) => c.supplierRef).length,
      withPrice: candidates.filter((c) => c.price).length,
      withMinimumOrder: candidates.filter((c) => c.minimumOrder).length,
    },
    photoProblems: chosen.flatMap((x) => (x.photo?.status === "unusable" ? [{ listingUrl: x.listingUrl, attempts: x.photo.attempts }] : [])),
    manifest: `${caseId}.json`,
    externalRequests: 0,
  };

  await writeJsonAtomic(join(runDir, CATALOGUE_SNAPSHOT), {
    recordType: "provider_response_snapshot",
    schemaVersion: 1,
    dataSource,
    source: CATALOGUE_SOURCE_LABEL,
    mode: "keyword",
    providerRunId: runId,
    datasetId: null,
    finishedAt: finished,
    fetchedAt: finished,
    itemLimit: Math.max(1, selection.matches.length),
    truncated: false,
    items: selection.matches,
  });
  await writeJsonAtomic(join(runDir, `${caseId}.json`), manifest);
  await writeJsonAtomic(join(runDir, CATALOGUE_SUMMARY), summary);
  Object.assign(journal.runs[0], {
    state: "succeeded",
    queries: selection.reference.phrase ? [selection.reference.phrase] : [],
    finishedAt: finished,
    statusMessage: `${chosen.length} of ${selection.matches.length} saved product record(s) selected`,
    snapshotFile: CATALOGUE_SNAPSHOT,
    itemCount: selection.matches.length,
  });
  journal.manifestFile = `${caseId}.json`;
  journal.summaryFile = CATALOGUE_SUMMARY;
  journal.status = "completed";
  journal.updatedAt = finished;
  await saveJournal(runDir, journal);
  return { discoveryId, runDir, journal, summary, manifest };
}

/**
 * Re-reads a saved catalogue search for a sourcing run: its decisions (for
 * diagnostics) and a check that every copied photo still has the SHA-256
 * recorded when it was copied. A changed photo fails the search rather than
 * being compared under the wrong identity.
 */
export async function loadCatalogueSearch(runDir: string, journal: DiscoveryRunJournal): Promise<{ matches: CatalogueMatch[]; rejections: { reason: string }[] }> {
  if (journal.provider.service !== "local_catalogue") throw new JournalError("Not a catalogue search");
  const entry = journal.runs[0];
  if (!entry?.snapshotFile) throw new JournalError("The catalogue search has no saved decisions");
  const snapshot = await loadSnapshot(join(runDir, entry.snapshotFile));
  if (snapshot.providerRunId !== entry.providerRunId) throw new JournalError("The saved decisions do not belong to this catalogue search");
  const matches = snapshot.items as CatalogueMatch[];
  for (const x of matches) {
    if (x?.photo?.status !== "copied") continue;
    const bytes = await readFile(join(runDir, x.photo.localPath)).catch(() => null);
    if (!bytes) throw new JournalError(`The photo copied for "${x.title}" is missing; run a new catalogue search`);
    if (sha256(bytes) !== x.photo.sha256) throw new JournalError(`The photo copied for "${x.title}" changed after the search; run a new catalogue search`);
  }
  return { matches, rejections: matches.filter((x) => x.decision !== "selected").map((x) => ({ reason: x.decision })) };
}
