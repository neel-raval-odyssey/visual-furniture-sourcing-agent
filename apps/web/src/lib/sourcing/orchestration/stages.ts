import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkManifest, InputProblem, loadManifest } from "../cli/source-candidates";
import { importCuratedCandidates, type CuratedImport } from "../discovery/curated/curated-alibaba-adapter";
import type { CandidateManifest } from "../discovery/curated/manifest";
import { describeDiscoveryState, normalizeSavedRuns, type DiscoveryStateView } from "../discovery/providers/apify/discovery-run";
import { JournalError, loadJournal } from "../discovery/providers/apify/run-journal";
import { ProviderSchemaError } from "../discovery/providers/apify/normalize";
import type { CandidateListing } from "../domain";
import type { ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { EmbeddingProtocolError, EmbeddingServiceError } from "../shortlisting/protocol";
import { EvidenceError, planListingImages, prioritizeImages, resolveReferenceImage, type ListingImagePlan, type ReferenceEvidence } from "../shortlisting/evidence";
import { loadSavedShortlist, ShortlistFileError, type SavedShortlist } from "../shortlisting/shortlist-schema";
import { buildEmbedRequest, buildVisualShortlist } from "../shortlisting/shortlist";
import { IMAGE_SELECTION_POLICY, type VisualShortlist } from "../shortlisting/types";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { LocalVerificationEvidence } from "../verification/openai/evidence";
import { recordKey, verificationKey, type LoadedRecords, type VerificationRecord } from "../verification/openai/record";
import type { CandidateSourceSpec, SelectionPolicy } from "./journal";

/**
 * Orchestration stages. Each one composes an existing component; none
 * reimplements discovery, image checks, SigLIP or Sol. None makes an external
 * request: provider acquisition, remote image downloads and paid verification
 * are planned here and executed only by their own explicitly authorized commands.
 */

/** A stage cannot proceed. `blocked`: a prerequisite is missing; `failed`: an input is invalid. */
export class StageError extends Error {
  constructor(
    readonly state: "blocked" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "StageError";
  }
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- reference

export interface ReferenceStage {
  saved: SavedFingerprint;
  /**
   * The hash-checked reference photograph. Null only for synthetic cases that
   * have no photo file (their fixtures record a hash only); it is needed solely
   * to compute a new SigLIP shortlist.
   */
  evidence: ReferenceEvidence | null;
  warning: string | null;
}

/** Saved Luna fingerprint (never re-run) and the hash-checked reference photograph. */
export async function loadReferenceStage(recordPath: string, imagesMapPath: string, caseId: string, allowSynthetic: boolean): Promise<ReferenceStage> {
  let saved: SavedFingerprint;
  try {
    saved = await loadSavedFingerprint(recordPath, caseId);
  } catch (error) {
    if (error instanceof SavedRunError) throw new StageError(error.problem === "missing_record" ? "blocked" : "failed", error.message);
    throw error;
  }
  if (saved.fingerprint.source.dataSource === "mock" && !allowSynthetic) {
    throw new StageError("failed", "The saved fingerprint is synthetic; pass --synthetic to use synthetic data");
  }
  try {
    return { saved, evidence: await resolveReferenceImage(imagesMapPath, saved), warning: null };
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    // A wrong photo always fails. A synthetic case without a photo file continues without it.
    const absent = /no reference photograph for case|not found|cannot be read/.test(error.message);
    if (saved.fingerprint.source.dataSource === "mock" && absent) {
      return { saved, evidence: null, warning: `Synthetic reference has no photo file (${error.message}); SigLIP cannot be recomputed for it.` };
    }
    throw new StageError("failed", error.message);
  }
}

// ---------------------------------------------------------------- candidates

export interface DiscoveryDiagnostics {
  discoveryId: string;
  state: DiscoveryStateView;
  manifestOrigin: "recorded_in_run" | "normalized_offline_from_snapshots";
  providerErrors: { mode: string; code: string; message: string }[];
  rejectedRows: Record<string, number>;
  unsuccessfulRuns: { mode: string; state: string; error: string | null }[];
}

export interface CandidateStage {
  manifest: CandidateManifest;
  /** Folder that local evidence paths are relative to. */
  manifestDir: string;
  /** Hash of the manifest content used (file bytes, or canonical JSON when derived from snapshots). */
  manifestSha256: string;
  imported: CuratedImport;
  discovery: DiscoveryDiagnostics | null;
  state: "completed" | "partial";
  warnings: string[];
}

function asStageError(error: unknown): never {
  if (error instanceof InputProblem) throw new StageError(error.exitCode === 2 ? "blocked" : "failed", error.message);
  if (error instanceof JournalError || error instanceof ProviderSchemaError) throw new StageError("failed", error.message);
  throw error;
}

export async function loadCuratedCandidates(manifestPath: string, label: string, ref: ReferenceStage, synthetic: boolean): Promise<CandidateStage> {
  try {
    const loaded = await loadManifest(manifestPath, label);
    const problems = await checkManifest(loaded, ref.saved, label, synthetic, { checkLocalFiles: false });
    if (problems.length) throw new StageError("failed", problems.join("; "));
    if (loaded.manifest.capture.status !== "completed") throw new StageError("blocked", `Manifest ${label} is not filled in yet (missing input, not an empty search)`);
    return {
      manifest: loaded.manifest,
      manifestDir: join(manifestPath, ".."),
      manifestSha256: sha256(await readFile(manifestPath)),
      imported: importCuratedCandidates([loaded.manifest]),
      discovery: null,
      state: "completed",
      warnings: [],
    };
  } catch (error) {
    if (error instanceof StageError) throw error;
    asStageError(error);
  }
}

/** A saved P1-004 discovery run. Never contacts the provider; a pending run is reported, not resumed. */
export async function loadProviderRunCandidates(runDir: string, label: string, ref: ReferenceStage, synthetic: boolean): Promise<CandidateStage> {
  try {
    const journal = await loadJournal(runDir);
    if (journal.caseId !== ref.saved.caseId) throw new StageError("failed", `Discovery run belongs to case "${journal.caseId}"`);
    if (journal.reference.fingerprintId !== ref.saved.fingerprint.id || journal.reference.sha256 !== ref.saved.record.image.sha256) {
      throw new StageError("failed", "Discovery run was made from a different fingerprint or reference image");
    }
    if (journal.dataSource === "mock" && !synthetic) throw new StageError("failed", "Discovery run is synthetic; pass --synthetic to use it");
    const state = describeDiscoveryState(journal);
    if (state.externalWorkPending) {
      throw new StageError("blocked", `Discovery run ${journal.discoveryId}: ${state.meaning}. Resume it with discover:marketplace --resume (not done here).`);
    }
    if (state.snapshotsAvailable === 0) {
      throw new StageError("failed", `Discovery run ${journal.discoveryId}: ${state.meaning}. No candidates are available; this is not an empty result.`);
    }
    // Diagnostics always come from the saved snapshots, so provider error rows and rejections stay visible.
    const normalized = await normalizeSavedRuns(runDir, journal, ref.saved);
    let manifest = normalized.build.manifest;
    let manifestSha256 = sha256(JSON.stringify(manifest));
    let origin: DiscoveryDiagnostics["manifestOrigin"] = "normalized_offline_from_snapshots";
    if (journal.manifestFile) {
      const loaded = await loadManifest(join(runDir, journal.manifestFile), `${label}/${journal.manifestFile}`);
      const problems = await checkManifest(loaded, ref.saved, label, synthetic, { checkLocalFiles: false });
      if (problems.length) throw new StageError("failed", problems.join("; "));
      manifest = loaded.manifest;
      manifestSha256 = sha256(await readFile(join(runDir, journal.manifestFile)));
      origin = "recorded_in_run";
    }
    const rejectedRows: Record<string, number> = {};
    for (const r of normalized.build.rejections) rejectedRows[r.reason] = (rejectedRows[r.reason] ?? 0) + 1;
    const unsuccessfulRuns = journal.runs
      .filter((r) => r.state !== "succeeded")
      .map((r) => ({ mode: r.mode, state: r.state, error: r.error ? `${r.error.category}: ${r.error.message}` : r.statusMessage }));
    const warnings = [
      ...(origin === "normalized_offline_from_snapshots" ? ["No manifest was recorded in the discovery run; candidates were normalized offline from its saved snapshots."] : []),
      ...unsuccessfulRuns.map((r) => `Provider ${r.mode} run did not succeed (${r.state}${r.error ? `: ${r.error}` : ""}); its results are missing, not empty.`),
    ];
    return {
      manifest,
      manifestDir: runDir,
      manifestSha256,
      imported: importCuratedCandidates([manifest]),
      discovery: {
        discoveryId: journal.discoveryId,
        state,
        manifestOrigin: origin,
        providerErrors: normalized.providerErrors.map((e) => ({ mode: e.mode, code: e.code, message: e.message })),
        rejectedRows,
        unsuccessfulRuns,
      },
      state: unsuccessfulRuns.length ? "partial" : "completed",
      warnings,
    };
  } catch (error) {
    if (error instanceof StageError) throw error;
    asStageError(error);
  }
}

/** Live provider acquisition is not authorized; the stage is always blocked. */
export const LIVE_DISCOVERY_BLOCKER =
  "Live provider acquisition is disabled: access and data-use authorization for the third-party provider (Apify Actor scrapewise/alibaba-com-scraper) has not been established, and AGENTS.md requires a confirmed, authorized integration. A --data-use-reviewed flag is not proof of authorization.";

export function sourceLabel(source: CandidateSourceSpec): string {
  return source.kind === "curated" ? `curated manifest ${source.manifest}` : source.kind === "provider-run" ? `saved discovery run ${source.discoveryRun}` : "live provider acquisition";
}

// ---------------------------------------------------------------- image evidence

export type EvidenceStatus =
  | "available"
  | "remote_only"
  | "no_image"
  | "missing_file"
  | "corrupt"
  | "unsupported_format"
  | "too_large"
  | "rejected_security"
  | "unreadable";

export interface ListingEvidence {
  listingId: string;
  status: EvidenceStatus;
  image: { ref: string; uri: string; sha256: string; mimeType: string; width: number; height: number; fallback: boolean } | null;
  problems: { ref: string; problem: string; message: string }[];
  /** Kept for the shortlist stage. */
  plan: ListingImagePlan | null;
}

/** Per-listing readiness using the shortlist evidence resolver and the verification image checks. No downloads. */
export async function assessImageEvidence(listings: readonly CandidateListing[], manifestDir: string, caseId: string, referenceId: string): Promise<ListingEvidence[]> {
  // LocalVerificationEvidence.candidate() only reads candidate files; the reference entry is not used here.
  const reference: ReferenceEvidence = { id: referenceId, path: "", sha256: "" };
  const out: ListingEvidence[] = [];
  for (const listing of listings) {
    const base = { listingId: listing.id, image: null, problems: [] as ListingEvidence["problems"], plan: null };
    if (listing.images.length === 0) {
      out.push({ ...base, status: "no_image" });
      continue;
    }
    let plan: ListingImagePlan;
    try {
      [plan] = await planListingImages([listing], manifestDir, caseId);
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      out.push({ ...base, status: "rejected_security", problems: [{ ref: "(listing images)", problem: "rejected_security", message: error.message }] });
      continue;
    }
    let chosen;
    try {
      chosen = await new LocalVerificationEvidence(reference, [plan]).candidate(listing);
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      out.push({ ...base, plan, status: "rejected_security", problems: [{ ref: "(listing images)", problem: "rejected_security", message: error.message }] });
      continue;
    }
    if (!("unusable" in chosen)) {
      const first = prioritizeImages(listing.images)[0];
      out.push({
        ...base,
        plan,
        status: "available",
        image: { ref: chosen.ref, uri: chosen.uri, sha256: chosen.sha256, mimeType: chosen.mimeType, width: chosen.width, height: chosen.height, fallback: first?.uri !== chosen.uri },
        problems: [...plan.rejected].map((r) => ({ ...r })),
      });
      continue;
    }
    const problems = chosen.unusable.map((r) => ({ ...r }));
    const has = (p: string) => problems.some((x) => x.problem === p);
    const status: EvidenceStatus = has("decode_failed")
      ? "corrupt"
      : has("unsupported_format")
        ? "unsupported_format"
        : has("too_large")
          ? "too_large"
          : has("missing_file") || has("not_found") || has("empty_file") || has("empty")
            ? "missing_file"
            : problems.length > 0 && problems.every((x) => x.problem === "remote_url_not_fetched")
              ? "remote_only"
              : "unreadable";
    out.push({ ...base, plan, status, problems });
  }
  return out;
}

// ---------------------------------------------------------------- shortlist

export interface ShortlistStage {
  state: "reused" | "completed" | "blocked" | "skipped";
  /** Where the shortlist came from (repo-relative or run-relative path). */
  source: string | null;
  model: { id: string; revision: string } | null;
  preprocessing: Record<string, unknown> | null;
  createdAt: string | null;
  /** Ranks and cosines by listing id (only listings the shortlist embedded). */
  entries: Map<string, { rank: number; cosine: number | null }>;
  reasons: string[];
  /** A newly computed shortlist, to be saved in the run folder. */
  computed: VisualShortlist | null;
}

export interface ShortlistContext {
  caseId: string;
  ref: ReferenceStage;
  modelId: string;
  /** Revision of the locally cached checkpoint, when the vision environment could report it. */
  cachedRevision: string | null;
  eligible: ListingEvidence[];
  synthetic: boolean;
}

/** Problems that make a saved shortlist unusable for the current inputs (empty = reusable). */
export function shortlistIncompatibilities(saved: SavedShortlist, ctx: ShortlistContext): string[] {
  const problems: string[] = [];
  const ref = ctx.ref.saved;
  if (saved.caseId !== ctx.caseId) problems.push(`case is ${saved.caseId}`);
  if (saved.reference.sha256 !== ref.record.image.sha256 || saved.reference.referenceImageId !== ref.reference.id) problems.push("reference image differs");
  if (saved.reference.fingerprintId !== ref.fingerprint.id) problems.push("fingerprint differs");
  if (!saved.model) problems.push("no model ran for that shortlist");
  else {
    if (saved.model.id !== ctx.modelId) problems.push(`checkpoint ${saved.model.id} differs from ${ctx.modelId}`);
    if (ctx.cachedRevision && saved.model.revision !== ctx.cachedRevision) problems.push(`checkpoint revision ${saved.model.revision} differs from the cached ${ctx.cachedRevision}`);
  }
  if (saved.imageSelectionPolicy !== undefined && saved.imageSelectionPolicy !== IMAGE_SELECTION_POLICY) problems.push("image-selection policy differs");
  if (saved.synthetic !== ctx.synthetic) problems.push("synthetic/genuine data differs");
  const entries = new Map(saved.shortlist.map((e) => [e.listingId, e]));
  const eligibleIds = new Set(ctx.eligible.map((e) => e.listingId));
  for (const e of ctx.eligible) {
    const s = entries.get(e.listingId);
    if (!s) problems.push(`${e.listingId} has no scored entry`);
    else if (s.image.sha256 !== e.image!.sha256 || s.image.ref !== e.image!.ref) problems.push(`${e.listingId} image changed`);
  }
  for (const id of [...entries.keys(), ...saved.belowTopK]) if (!eligibleIds.has(id)) problems.push(`${id} is not a current candidate with an image`);
  return problems;
}

export interface ShortlistStageInput extends ShortlistContext {
  imported: CuratedImport;
  candidatePaths: { path: string; label: string }[];
  /** null: the SigLIP stage may only reuse. */
  runner: ImageSimilarityRunner | null;
  allowRecompute: boolean;
  /** false in plan mode: report what would happen without computing. */
  execute: boolean;
  now: () => Date;
}

export async function runShortlistStage(input: ShortlistStageInput): Promise<ShortlistStage> {
  const empty = { source: null, model: null, preprocessing: null, createdAt: null, entries: new Map(), computed: null };
  if (input.eligible.length === 0) return { ...empty, state: "skipped", reasons: ["no candidate has a usable local image"] };
  const reasons: string[] = [];
  for (const c of input.candidatePaths) {
    let saved: SavedShortlist;
    try {
      saved = await loadSavedShortlist(c.path, c.label);
    } catch (error) {
      if (!(error instanceof ShortlistFileError)) throw error;
      if (!error.missing) reasons.push(error.message);
      continue;
    }
    const problems = shortlistIncompatibilities(saved, input);
    if (problems.length) {
      reasons.push(`${c.label} not reusable: ${problems.join("; ")}`);
      continue;
    }
    if (!input.cachedRevision) reasons.push(`${c.label}: checkpoint revision could not be re-checked (local vision environment unavailable)`);
    const entries = new Map<string, { rank: number; cosine: number | null }>(saved.shortlist.map((e) => [e.listingId, { rank: e.rank, cosine: e.embeddingCosineSimilarity }]));
    saved.belowTopK.forEach((id, i) => entries.set(id, { rank: saved.shortlist.length + i + 1, cosine: null }));
    return {
      state: "reused",
      source: c.label,
      model: saved.model ? { id: saved.model.id, revision: saved.model.revision } : null,
      preprocessing: saved.preprocessing ?? null,
      createdAt: saved.createdAt,
      entries,
      reasons,
      computed: null,
    };
  }
  if (!input.allowRecompute) return { ...empty, state: "blocked", reasons: [...reasons, "no reusable shortlist and recomputation is disabled (--no-recompute)"] };
  if (!input.ref.evidence) return { ...empty, state: "blocked", reasons: [...reasons, "no reference photo file to embed (synthetic case)"] };
  if (!input.runner || !input.cachedRevision) {
    return { ...empty, state: "blocked", reasons: [...reasons, "no reusable shortlist and the local SigLIP 2 checkpoint is not available (nothing is downloaded automatically)"] };
  }
  if (!input.execute) return { ...empty, state: "blocked", reasons: [...reasons, "would compute a new shortlist with the cached local checkpoint"] };
  const plans = input.eligible.map((e) => e.plan!);
  const request = buildEmbedRequest(input.ref.evidence!, plans, { id: input.modelId, revision: input.cachedRevision }, "auto");
  try {
    const response = await input.runner.embed(request);
    const computed = buildVisualShortlist({
      caseId: input.caseId,
      saved: input.ref.saved,
      imported: input.imported,
      plans,
      response,
      topK: plans.length,
      createdAt: input.now().toISOString(),
    });
    const entries = new Map(computed.shortlist.map((e) => [e.listingId, { rank: e.rank, cosine: e.embeddingCosineSimilarity }]));
    return { state: "completed", source: "shortlist.json", model: { id: computed.model!.id, revision: computed.model!.revision }, preprocessing: computed.preprocessing, createdAt: computed.createdAt, entries, reasons, computed };
  } catch (error) {
    if (error instanceof EmbeddingServiceError || error instanceof EmbeddingProtocolError) {
      return { ...empty, state: "blocked", reasons: [...reasons, `local SigLIP 2 run failed: ${error.message}`] };
    }
    throw error;
  }
}

// ---------------------------------------------------------------- verification

export type VerificationStatus = "reused" | "ambiguous" | "failed" | "interrupted" | "stale" | "missing" | "not_eligible";

export interface ListingVerification {
  listingId: string;
  status: VerificationStatus;
  /** Chosen by the selection policy as a candidate for detailed verification. */
  selected: boolean;
  selectionNote: string;
  record: { file: string; record: VerificationRecord } | null;
  /** Why existing records do not apply (stale), or which records conflict (ambiguous). */
  notes: string[];
}

export interface VerificationSettings {
  model: string;
  instructionsVersion: string;
  imageDetail: string;
  reasoningEffort: string;
}

/** Matches saved Sol records to the current pairs. Never makes a request. */
export function classifyVerifications(input: {
  caseId: string;
  referenceSha256: string;
  evidence: ListingEvidence[];
  records: LoadedRecords["records"];
  settings: VerificationSettings;
  preferLatest: boolean;
}): ListingVerification[] {
  return input.evidence.map((e) => {
    const base = { listingId: e.listingId, selected: false, selectionNote: "", record: null, notes: [] as string[] };
    if (e.status !== "available") return { ...base, status: "not_eligible" as const, notes: [`no usable image (${e.status})`] };
    const key = verificationKey({
      caseId: input.caseId,
      listingId: e.listingId,
      referenceSha256: input.referenceSha256,
      candidateSha256: e.image!.sha256,
      model: input.settings.model,
      instructionsVersion: input.settings.instructionsVersion,
      imageDetail: input.settings.imageDetail,
      reasoningEffort: input.settings.reasoningEffort,
    });
    const forListing = input.records.filter((r) => r.record.listingId === e.listingId);
    const matching = forListing.filter((r) => recordKey(r.record) === key).sort((a, b) => (a.record.requestedAt < b.record.requestedAt ? 1 : -1));
    const succeeded = matching.filter((r) => r.record.status === "succeeded");
    if (succeeded.length === 1 || (succeeded.length > 1 && input.preferLatest)) {
      return { ...base, status: "reused" as const, record: succeeded[0], notes: succeeded.length > 1 ? [`latest of ${succeeded.length} compatible records chosen (--prefer-latest-verification)`] : [] };
    }
    if (succeeded.length > 1) return { ...base, status: "ambiguous" as const, notes: succeeded.map((r) => r.file) };
    if (matching.length) {
      const latest = matching[0];
      return latest.record.status === "requested"
        ? { ...base, status: "interrupted" as const, notes: [`${latest.file}: request sent, no result recorded`] }
        : { ...base, status: "failed" as const, notes: [`${latest.file}: ${latest.record.status}${latest.record.error ? ` (${latest.record.error.category})` : ""}`] };
    }
    if (forListing.length) {
      const diffs = new Set<string>();
      for (const { record: r } of forListing) {
        if (r.candidateImage.sha256 !== e.image!.sha256) diffs.add("candidate image changed");
        if (r.referenceImage.sha256 !== input.referenceSha256) diffs.add("reference image differs");
        if (r.request.model !== input.settings.model) diffs.add(`model ${r.request.model}`);
        if (r.request.instructionsVersion !== input.settings.instructionsVersion) diffs.add(`instructions ${r.request.instructionsVersion}`);
        if (r.request.imageDetail !== input.settings.imageDetail || r.request.reasoningEffort !== input.settings.reasoningEffort) diffs.add("request settings differ");
      }
      return { ...base, status: "stale" as const, notes: [...diffs] };
    }
    return { ...base, status: "missing" as const };
  });
}

export interface SelectionOutcome {
  /** Listings whose missing or stale assessment would need a new paid request. */
  toRequest: string[];
  excluded: { listingId: string; siglipRank: number | null; cosine: number | null; reason: string; everVerified: boolean }[];
}

/**
 * Applies the selection policy. "all": every eligible listing. "top-k": the k
 * best SigLIP ranks; listings without a rank are excluded with a reason. An
 * excluded listing with a reusable assessment keeps it (reuse costs nothing).
 */
export function applySelectionPolicy(entries: ListingVerification[], policy: SelectionPolicy, ranks: Map<string, { rank: number; cosine: number | null }>): SelectionOutcome {
  const eligible = entries.filter((e) => e.status !== "not_eligible");
  let selected: Set<string>;
  if (policy.kind === "all") selected = new Set(eligible.map((e) => e.listingId));
  else {
    const ranked = eligible.filter((e) => ranks.has(e.listingId)).sort((a, b) => ranks.get(a.listingId)!.rank - ranks.get(b.listingId)!.rank);
    selected = new Set(ranked.slice(0, policy.k).map((e) => e.listingId));
  }
  const excluded: SelectionOutcome["excluded"] = [];
  for (const e of entries) {
    e.selected = selected.has(e.listingId);
    const r = ranks.get(e.listingId);
    if (e.status === "not_eligible") {
      e.selectionNote = "not eligible: no usable image";
    } else if (e.selected) {
      e.selectionNote = policy.kind === "all" ? "selected: all eligible candidates" : `selected: SigLIP rank ${r!.rank} within top ${policy.k}`;
    } else {
      const reason = !r ? "no SigLIP rank (shortlist unavailable for it)" : `SigLIP rank ${r.rank} is outside top ${(policy as { k: number }).k}`;
      e.selectionNote = `excluded: ${reason}`;
      excluded.push({ listingId: e.listingId, siglipRank: r?.rank ?? null, cosine: r?.cosine ?? null, reason, everVerified: e.status === "reused" });
    }
  }
  return { toRequest: entries.filter((e) => e.selected && (e.status === "missing" || e.status === "stale")).map((e) => e.listingId), excluded };
}
