import { randomUUID } from "node:crypto";
import { readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../discovery/providers/apify/run-journal";
import { candidateSetTag } from "../discovery/curated/curated-alibaba-adapter";
import type { ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { renderShortlistMarkdown } from "../shortlisting/report";
import { loadVerificationRecords } from "../verification/openai/record";
import { assembleSourcingResult, renderSourcingResultMarkdown, type SourcingResult } from "./assemble";
import {
  computeInputIdentity,
  emptyStages,
  loadRunJournal,
  newRunId,
  saveRunJournal,
  STAGES,
  type CandidateSourceSpec,
  type SelectionPolicy,
  type SourcingRunJournal,
  type StageName,
  type StageState,
} from "./journal";
import {
  applySelectionPolicy,
  assessImageEvidence,
  classifyVerifications,
  LIVE_DISCOVERY_BLOCKER,
  loadCuratedCandidates,
  loadProviderRunCandidates,
  loadReferenceStage,
  runShortlistStage,
  sourceLabel,
  StageError,
  type CandidateStage,
  type ListingEvidence,
  type ListingVerification,
  type ReferenceStage,
  type SelectionOutcome,
  type ShortlistStage,
  type VerificationSettings,
} from "./stages";

/**
 * AutomatedSourcingOrchestrator: reference → candidates → image evidence →
 * SigLIP 2 shortlist → Sol verification (reuse) → consolidated result.
 * It composes the existing components and makes no external request:
 * marketplace acquisition, remote image downloads and paid Sol requests are
 * only planned, with the exact separately authorized commands to run them.
 */

export interface OrchestratorConfig {
  caseId: string;
  source: CandidateSourceSpec;
  synthetic: boolean;
  selection: SelectionPolicy;
  siglip: { modelId: string; allowRecompute: boolean; shortlist: string | null };
  sol: VerificationSettings;
  preferLatestVerification: boolean;
  paths: {
    recordPath: string;
    imagesMapPath: string;
    shortlistsDir: string;
    verificationsDir: string;
    runsDir: string;
    /** Resolves a path stored in the journal (repo-relative or absolute). */
    resolve: (p: string) => string;
    /** Repo-relative display. */
    display: (p: string) => string;
  };
  /** Local SigLIP 2 component; null disables recomputation and revision checks. */
  runner: ImageSimilarityRunner | null;
  now: () => Date;
}

export interface StageReport {
  state: StageState;
  message: string | null;
}

export interface OrchestrationOutcome {
  status: SourcingRunJournal["status"];
  stages: Record<StageName, StageReport>;
  runId: string | null;
  runDir: string | null;
  result: SourcingResult | null;
  /** Earlier runs with the same input identity. */
  identicalRuns: string[];
  warnings: string[];
  followUps: string[];
  /** Plan details for display. */
  details: string[];
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
  await writeFile(tmp, text, { flag: "wx" });
  await rename(tmp, path);
}

const selectionLabel = (p: SelectionPolicy) => (p.kind === "all" ? "verify all eligible candidates" : `verify the top ${p.k} by SigLIP rank`);

class Halt extends Error {}

export async function runOrchestration(config: OrchestratorConfig, mode: "plan" | "run", resume?: { runDir: string; journal: SourcingRunJournal }): Promise<OrchestrationOutcome> {
  const { paths, caseId } = config;
  const stages = Object.fromEntries(STAGES.map((s) => [s, { state: "not_started" as StageState, message: null }])) as Record<StageName, StageReport>;
  const warnings: string[] = [];
  const followUps: string[] = [];
  const details: string[] = [];
  const at = config.now();
  const runId = resume?.journal.runId ?? (mode === "run" ? newRunId(at) : null);
  const runDir = resume?.runDir ?? (runId ? join(paths.runsDir, caseId, runId) : null);
  const journal: SourcingRunJournal | null =
    mode === "run"
      ? (resume?.journal ?? {
          recordType: "sourcing_orchestration_run",
          schemaVersion: 1,
          runId: runId!,
          caseId,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
          resumedAt: [],
          status: "running",
          inputIdentity: null,
          inputs: {
            source: config.source,
            synthetic: config.synthetic,
            selection: config.selection,
            siglip: config.siglip,
            sol: config.sol,
            preferLatestVerification: config.preferLatestVerification,
          },
          resolved: { referenceImageId: null, referenceSha256: null, fingerprintId: null, manifestSha256: null, candidateImages: {} },
          authorization: { externalDiscovery: "not_authorized", remoteImageDownload: "not_authorized", paidVerification: "not_authorized" },
          externalRequests: { marketplace: 0, imageDownloads: 0, paidModel: 0 },
          stages: emptyStages(),
        })
      : null;
  const priorIdentity = resume?.journal.inputIdentity ?? null;
  const priorResolved = resume ? structuredClone(resume.journal.resolved) : null;
  if (journal && resume) {
    journal.resumedAt.push(at.toISOString());
    journal.status = "running";
  }
  const persist = async () => {
    if (!journal || !runDir) return;
    journal.updatedAt = config.now().toISOString();
    await saveRunJournal(runDir, journal);
  };
  const set = async (name: StageName, state: StageState, message: string | null = null, output: string | null = null) => {
    stages[name] = { state, message };
    if (journal) {
      const prev = journal.stages[name];
      journal.stages[name] = {
        state,
        startedAt: state === "running" ? config.now().toISOString() : prev.startedAt,
        finishedAt: state === "running" ? null : config.now().toISOString(),
        output,
        message,
      };
      await persist();
    }
  };
  const stage = async <T>(name: StageName, fn: () => Promise<T>): Promise<T> => {
    await set(name, "running");
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StageError) {
        await set(name, error.state, error.message);
        throw new Halt(error.message);
      }
      await set(name, "failed", error instanceof Error ? error.message : "unexpected error");
      throw error;
    }
  };

  let result: SourcingResult | null = null;
  let identicalRuns: string[] = [];
  try {
    await persist();
    // 1. Reference: saved Luna fingerprint, hash-checked photo. Luna is never called.
    const ref: ReferenceStage = await stage("reference", () => loadReferenceStage(paths.recordPath, paths.imagesMapPath, caseId, config.synthetic));
    if (ref.warning) warnings.push(ref.warning);
    await set(
      "reference",
      ref.evidence ? "completed" : "partial",
      `${ref.saved.reference.id}, fingerprint ${ref.saved.fingerprint.id} (${ref.saved.fingerprint.source.modelId ?? ref.saved.fingerprint.source.kind}), ${ref.evidence ? "image sha256 verified" : "no photo file (synthetic)"}`,
    );
    if (journal) {
      Object.assign(journal.resolved, { referenceImageId: ref.saved.reference.id, referenceSha256: ref.saved.record.image.sha256, fingerprintId: ref.saved.fingerprint.id });
    }

    // 2. Candidates.
    const source = config.source;
    if (source.kind === "provider-live") {
      details.push(...liveDiscoveryPlan(config));
      await set("candidates", "blocked", LIVE_DISCOVERY_BLOCKER);
      followUps.push("Establish written access and data-use authorization for a discovery provider (or an official Alibaba.com API) before any live acquisition. Meanwhile use --source curated or --source provider-run.");
      throw new Halt(LIVE_DISCOVERY_BLOCKER);
    }
    const candidates: CandidateStage = await stage("candidates", () =>
      source.kind === "curated"
        ? loadCuratedCandidates(paths.resolve(source.manifest), source.manifest, ref, config.synthetic)
        : loadProviderRunCandidates(paths.resolve(source.discoveryRun), source.discoveryRun, ref, config.synthetic),
    );
    warnings.push(...candidates.warnings);
    const listings = candidates.imported.listings;
    await set("candidates", candidates.state, `${listings.length} listing(s), ${candidates.imported.suppliers.length} supplier(s) from ${sourceLabel(source)} (${candidates.imported.acquisitionMethod})`);
    if (journal) journal.resolved.manifestSha256 = candidates.manifestSha256;

    // 3. Image evidence (local files only; nothing downloaded).
    const evidence: ListingEvidence[] = await stage("image_evidence", () => assessImageEvidence(listings, candidates.manifestDir, caseId, ref.saved.reference.id));
    const available = evidence.filter((e) => e.status === "available");
    if (journal) journal.resolved.candidateImages = Object.fromEntries(evidence.map((e) => [e.listingId, e.image?.sha256 ?? null]));
    const missing = evidence.length - available.length;
    await set(
      "image_evidence",
      listings.length === 0 ? "skipped" : missing ? "partial" : "completed",
      listings.length === 0 ? "no candidates" : `${available.length} of ${evidence.length} with a usable local image`,
    );
    if (evidence.some((e) => e.status === "remote_only") && source.kind === "provider-run" && candidates.imported.dataSource === "live") {
      followUps.push(
        `Some listings have only remote image URLs. Caching them is an external operation needing its own authorization: pnpm discover:marketplace --case ${caseId} --fetch-images ${source.discoveryRun} --data-use-reviewed`,
      );
    }

    if (journal) {
      const identity = computeInputIdentity(journal);
      if (priorIdentity && priorIdentity !== identity) {
        // Inputs changed since this run: restore what it recorded and stop instead of mixing results.
        const changed = Object.keys(journal.resolved).filter(
          (k) => JSON.stringify(journal.resolved[k as keyof typeof journal.resolved]) !== JSON.stringify(priorResolved![k as keyof typeof priorResolved]),
        );
        journal.resolved = priorResolved!;
        journal.inputIdentity = priorIdentity;
        await set("assembly", "blocked", `inputs changed since run ${journal.runId} (${changed.join(", ")}); start a new run instead of resuming`);
        throw new Halt("inputs changed");
      }
      journal.inputIdentity = identity;
      identicalRuns = await findIdenticalRuns(paths.runsDir, caseId, journal.inputIdentity, journal.runId);
      await persist();
    }

    // 4. SigLIP 2 shortlist: reuse when compatible; compute locally only with a cached checkpoint.
    let cachedRevision: string | null = null;
    if (config.runner && available.length) {
      try {
        const env = await config.runner.environment({ id: config.siglip.modelId, revision: null });
        cachedRevision = env.model.cached ? env.model.revision : null;
        if (!env.model.cached) warnings.push(`SigLIP 2 checkpoint ${config.siglip.modelId} is not cached locally (${env.model.reason ?? "not cached"}); nothing is downloaded automatically.`);
      } catch (error) {
        warnings.push(`Local vision environment unavailable: ${(error as Error).message}`);
      }
    }
    const candidatePaths = [
      ...(runDir && resume ? [{ path: join(runDir, "shortlist.json"), label: `${paths.display(runDir)}/shortlist.json` }] : []),
      ...(config.siglip.shortlist
        ? [{ path: paths.resolve(config.siglip.shortlist), label: config.siglip.shortlist }]
        : [
            {
              path: join(paths.shortlistsDir, `${caseId}-${config.siglip.modelId.replace(/^google\//, "")}${candidateSetTag(candidates.imported)}.json`),
              label: paths.display(join(paths.shortlistsDir, `${caseId}-${config.siglip.modelId.replace(/^google\//, "")}${candidateSetTag(candidates.imported)}.json`)),
            },
          ]),
    ];
    const shortlist: ShortlistStage = await stage("shortlist", () =>
      runShortlistStage({
        caseId,
        ref,
        modelId: config.siglip.modelId,
        cachedRevision,
        eligible: available,
        synthetic: config.synthetic,
        imported: candidates.imported,
        candidatePaths,
        runner: config.runner,
        allowRecompute: config.siglip.allowRecompute,
        execute: mode === "run",
        now: config.now,
      }),
    );
    let shortlistOutput: string | null = shortlist.source;
    if (shortlist.computed && runDir) {
      await writeJsonAtomic(join(runDir, "shortlist.json"), shortlist.computed);
      await writeTextAtomic(join(runDir, "shortlist.md"), renderShortlistMarkdown(shortlist.computed));
      shortlistOutput = "shortlist.json";
    }
    warnings.push(...shortlist.reasons.filter((r) => shortlist.state !== "reused" || r.includes("could not be re-checked")));
    await set(
      "shortlist",
      shortlist.state,
      shortlist.state === "reused"
        ? `reused ${shortlist.source} (${shortlist.model?.id} @ ${shortlist.model?.revision})`
        : shortlist.state === "completed"
          ? `computed locally with ${shortlist.model?.id} @ ${shortlist.model?.revision}`
          : shortlist.reasons.at(-1) ?? null,
      shortlistOutput,
    );
    if (shortlist.state === "blocked") {
      followUps.push("SigLIP ranks are unavailable. Set up services/vision and download the checkpoint explicitly (services/vision/README.md); verification can still proceed without ranks under the 'all' policy.");
    }

    // 5. Sol verification: reuse saved records; never request here.
    const records = await loadVerificationRecords(paths.verificationsDir, caseId);
    for (const p of records.problems) warnings.push(`Unreadable verification record ${p.file}: ${p.detail}`);
    const verification: ListingVerification[] = classifyVerifications({
      caseId,
      referenceSha256: ref.saved.record.image.sha256,
      evidence,
      records: records.records,
      settings: config.sol,
      preferLatest: config.preferLatestVerification,
    });
    const selection: SelectionOutcome = applySelectionPolicy(verification, config.selection, shortlist.entries);
    const selected = verification.filter((v) => v.selected);
    const reused = verification.filter((v) => v.status === "reused");
    const verificationState: StageState = available.length === 0 ? "skipped" : selected.every((v) => v.status === "reused") ? "reused" : "partial";
    await set("verification", verificationState, `${reused.length} reused; ${selection.toRequest.length} new paid request(s) needed; 0 sent`);
    for (const v of verification) {
      if (v.status === "ambiguous") warnings.push(`${v.listingId}: several compatible Sol records exist (${v.notes.join(", ")}); none was chosen. Use --prefer-latest-verification to choose the latest deliberately.`);
      if (v.status === "failed" || v.status === "interrupted") warnings.push(`${v.listingId}: previous Sol attempt ${v.status} (${v.notes.join("; ")}); it is not retried automatically.`);
      if (v.status === "stale") warnings.push(`${v.listingId}: saved Sol records do not apply (${v.notes.join("; ")}).`);
    }
    if (selection.toRequest.length) {
      const dir = paths.display(candidates.manifestDir);
      const ids = selection.toRequest;
      followUps.push(
        `Paid Sol verification is a separate, explicitly authorized operation (not run here). For ${ids.length} candidate(s): ${ids
          .map((id) => `pnpm verify:visual --case ${caseId} --candidates ${dir} --listing-id ${id} --live --max-paid-requests 1`)
          .join(" ; ")}`,
      );
      if (candidates.discovery?.manifestOrigin === "normalized_offline_from_snapshots") {
        followUps.push("verify:visual reads a manifest file: the discovery run has none yet (its candidates were normalized from snapshots here).");
      }
    }
    if (verification.some((v) => v.status === "failed" || v.status === "interrupted")) {
      followUps.push("Review failed or interrupted Sol records before deliberately repeating them with verify:visual --rerun.");
    }
    details.push(
      `Selection: ${selectionLabel(config.selection)}; ${selection.excluded.length} excluded${selection.excluded.length ? ` (${selection.excluded.map((e) => `${e.listingId}: ${e.reason}`).join("; ")})` : ""}`,
      ...verification.map((v) => `  ${v.listingId}: Sol ${v.status}${v.record ? ` (${v.record.file})` : ""}; ${v.selectionNote}`),
      `External requests required for this result: 0 (paid Sol requests that would add coverage: ${selection.toRequest.length})`,
    );

    if (mode === "plan") {
      await set("assembly", "not_started", runDir ? null : `would write evals/local/sourcing-runs/${caseId}/<run id>/result.json and result.md`);
      const blocked = Object.values(stages).some((s) => s.state === "blocked" || s.state === "failed");
      return { status: blocked ? "blocked" : "running", stages, runId, runDir, result: null, identicalRuns, warnings, followUps, details };
    }

    // 6. Assembly.
    await set("assembly", "running");
    const stageSnapshot = Object.fromEntries(STAGES.map((s) => [s, { ...stages[s] }])) as Record<StageName, StageReport>;
    stageSnapshot.assembly = { state: "completed", message: "result.json and result.md" };
    result = assembleSourcingResult({
      runId: runId!,
      createdAt: config.now().toISOString(),
      caseId,
      synthetic: config.synthetic && (candidates.imported.dataSource === "mock" || ref.saved.fingerprint.source.dataSource === "mock"),
      sourceKind: source.kind,
      sourceLabel: sourceLabel(source),
      ref,
      candidates,
      evidence,
      shortlist,
      verification,
      selection,
      selectionLabel: selectionLabel(config.selection),
      sol: config.sol,
      stages: stageSnapshot,
      warnings,
      followUps,
    });
    await writeJsonAtomic(join(runDir!, "result.json"), result);
    await writeTextAtomic(join(runDir!, "result.md"), renderSourcingResultMarkdown(result));
    await set("assembly", "completed", "result.json and result.md", "result.json");
    const complete = ["completed", "reused"];
    const full = complete.includes(stages.reference.state) && complete.includes(stages.candidates.state) && complete.includes(stages.image_evidence.state) && complete.includes(stages.shortlist.state) && complete.includes(stages.verification.state);
    journal!.status = full ? "completed" : "partial";
    await persist();
    return { status: journal!.status, stages, runId, runDir, result, identicalRuns, warnings, followUps, details };
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    const status: SourcingRunJournal["status"] = Object.values(stages).some((s) => s.state === "failed") ? "failed" : "blocked";
    if (journal) {
      journal.status = status;
      await persist();
    }
    return { status, stages, runId, runDir, result, identicalRuns, warnings, followUps, details };
  }
}

async function findIdenticalRuns(runsDir: string, caseId: string, identity: string, self: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(runsDir, caseId))).filter((n) => n.startsWith("src-") && n !== self).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    try {
      const j = await loadRunJournal(join(runsDir, caseId, n));
      if (j.inputIdentity === identity) out.push(n);
    } catch {
      // unreadable runs are ignored here
    }
  }
  return out;
}

/** What a future authorized live run would do; nothing is started. */
function liveDiscoveryPlan(config: OrchestratorConfig): string[] {
  return [
    "Live discovery plan (NOT executable: access authorization not established):",
    "  Provider: apify-alibaba-discovery → Apify Actor scrapewise/alibaba-com-scraper (third-party scraper, not an official Alibaba.com API)",
    "  Modes: image (requires uploading the reference photo: --authorize-image-upload and an image transport), keyword (saved Luna queries), hybrid",
    "  Caps: --max-results 1–50 and --max-provider-cost-usd (hard Apify maxTotalChargeUsd); 300 s run timeout; no retried starts",
    "  Image acquisition: separate --download-images / --fetch-images step (alicdn.com/alibaba.com over HTTPS, size/time limited)",
    `  SigLIP 2: ${config.siglip.modelId} (local; cached checkpoint only)`,
    `  Verification: ${selectionLabel(config.selection)}; potential Sol calls up to the number of eligible candidates (or k), each needing verify:visual --live --max-paid-requests`,
    "  Credentials required: APIFY_TOKEN (discovery), OPENAI_API_KEY (paid verification). Their presence is never treated as authorization.",
    "  Missing: written provider access/data-use authorization; a decision on AGENTS.md's 'authorized integration, no scraping' rule; explicit per-operation approval.",
  ];
}

export async function loadRunForResume(runsDir: string, caseId: string, runId: string): Promise<{ runDir: string; journal: SourcingRunJournal }> {
  if (!/^src-[0-9TZ-]+-[0-9a-f]{6}$/.test(runId)) throw new StageError("failed", "Invalid run id");
  const runDir = join(runsDir, caseId, runId);
  const journal = await loadRunJournal(runDir);
  if (journal.caseId !== caseId) throw new StageError("failed", `Run ${runId} belongs to case ${journal.caseId}`);
  return { runDir, journal };
}
