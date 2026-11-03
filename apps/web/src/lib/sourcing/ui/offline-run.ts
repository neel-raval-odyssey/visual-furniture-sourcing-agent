import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import { loadJournal } from "../discovery/providers/apify/run-journal";
import { runOrchestration, type OrchestratorConfig } from "../orchestration/orchestrator";
import { PythonImageSimilarityRunner, type ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { DEFAULT_MODEL_ID } from "../shortlisting/protocol";
import { VISUAL_VERIFICATION_INSTRUCTIONS_VERSION } from "../verification/openai/instructions";
import { DEFAULT_VERIFICATION_REQUEST_SETTINGS, DEFAULT_VISUAL_VERIFICATION_MODEL } from "../verification/openai/verification-client";
import { CASE_ID, getReference, listRuns, type Paths } from "./data";
import { readCollection } from "./intake/revision";

/**
 * "Run using saved evidence": the P1-005 orchestrator over the case's curated
 * manifest, offline. It reuses compatible shortlists and Sol records, may run
 * SigLIP 2 locally with an already-cached checkpoint, and never makes a
 * marketplace, image-download or paid model request (the orchestrator has no
 * such capability). One run per case at a time.
 */

const inFlight = new Set<string>();

export type OfflineRunOutcome =
  | { ok: true; runId: string; status: string }
  | { ok: false; status: 400 | 404 | 409; code: "invalid_case" | "not_found" | "not_eligible" | "already_running"; message: string };

/** Which saved candidate set a comparison uses: the hand-collected list, or one saved automatic search. Never both silently. */
export type CandidateSetChoice = { kind: "collection" } | { kind: "automatic"; discoveryId: string };

const DISCOVERY_ID = /^disc-[0-9TZ-]+-[0-9a-f]{6}$/;

export function curatedOfflineConfig(
  paths: Paths,
  caseId: string,
  runner: ImageSimilarityRunner | null,
  now: () => Date = () => new Date(),
  choice: CandidateSetChoice = { kind: "collection" },
): OrchestratorConfig {
  const display = (p: string) => relative(paths.root, p) || p;
  return {
    caseId,
    source:
      choice.kind === "automatic"
        ? // A display string (resolved by the orchestrator); built without path.join so the bundler does not trace the whole project.
          { kind: "provider-run", discoveryRun: display(`${paths.discovery}/${caseId}/${choice.discoveryId}`) }
        : { kind: "curated", manifest: display(join(paths.candidates, `${caseId}.json`)) },
    synthetic: false,
    selection: { kind: "all" },
    siglip: { modelId: DEFAULT_MODEL_ID, allowRecompute: true, shortlist: null },
    sol: {
      model: DEFAULT_VISUAL_VERIFICATION_MODEL,
      instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
      imageDetail: DEFAULT_VERIFICATION_REQUEST_SETTINGS.imageDetail,
      reasoningEffort: DEFAULT_VERIFICATION_REQUEST_SETTINGS.reasoningEffort,
    },
    preferLatestVerification: false,
    paths: {
      recordPath: join(paths.predictions, `${caseId}.json`),
      imagesMapPath: paths.imagesMap,
      shortlistsDir: paths.shortlists,
      verificationsDir: paths.verifications,
      runsDir: paths.sourcingRuns,
      resolve: (p) => (p.startsWith("/") ? p : join(paths.root, p)),
      display,
    },
    runner,
    now,
  };
}

export function defaultRunner(paths: Paths): ImageSimilarityRunner {
  const serviceDir = join(paths.root, "services/vision");
  return new PythonImageSimilarityRunner({ python: join(serviceDir, ".venv/bin/python"), serviceDir });
}

/** Products in a saved automatic search, and how many have a local photo. Null when it has no saved product set. */
export async function automaticSetPhotos(paths: Paths, caseId: string, discoveryId: string): Promise<{ products: number; withPhoto: number } | null> {
  if (!DISCOVERY_ID.test(discoveryId)) return null;
  const runDir = join(paths.discovery, caseId, discoveryId);
  const journal = await loadJournal(runDir).catch(() => null);
  if (!journal || journal.caseId !== caseId || !journal.manifestFile) return null;
  const parsed = candidateManifestSchema.safeParse(JSON.parse(await readFile(join(runDir, journal.manifestFile), "utf8").catch(() => "null")));
  if (!parsed.success) return null;
  return { products: parsed.data.candidates.length, withPhoto: parsed.data.candidates.filter((c) => c.images.some((i) => "localPath" in i)).length };
}

export async function startOfflineRun(
  paths: Paths,
  caseId: string,
  deps: { runner?: ImageSimilarityRunner | null; now?: () => Date } = {},
  choice: CandidateSetChoice = { kind: "collection" },
): Promise<OfflineRunOutcome> {
  if (!CASE_ID.test(caseId)) return { ok: false, status: 400, code: "invalid_case", message: "Invalid case id" };
  if (choice.kind === "automatic" && !DISCOVERY_ID.test(choice.discoveryId)) return { ok: false, status: 400, code: "invalid_case", message: "Invalid search id" };
  // Reserve the case before any await, so two simultaneous requests cannot both start a run.
  if (inFlight.has(caseId)) return { ok: false, status: 409, code: "already_running", message: "A sourcing run for this reference is already in progress." };
  inFlight.add(caseId);
  try {
    const reference = await getReference(paths, caseId);
    if (!reference) return { ok: false, status: 404, code: "not_found", message: "No such reference" };
    if (reference.synthetic || reference.understanding !== "furniture_identified") {
      return { ok: false, status: 409, code: "not_eligible", message: "This reference has no saved fingerprint to run from." };
    }
    if (choice.kind === "automatic") {
      const set = await automaticSetPhotos(paths, caseId, choice.discoveryId);
      if (!set) return { ok: false, status: 404, code: "not_found", message: "That automatic search has no saved products." };
      if (set.withPhoto === 0) return { ok: false, status: 409, code: "not_eligible", message: "None of these products has a usable photo yet, so there is nothing to compare." };
    } else {
      if (reference.candidates.state !== "completed") {
        return { ok: false, status: 409, code: "not_eligible", message: "This reference has no saved fingerprint and completed candidate set to run from." };
      }
      // A comparison needs at least one product photo; otherwise it could only return empty cards.
      const collection = await readCollection(paths, caseId);
      if (collection && collection.withPhoto === 0) {
        return { ok: false, status: 409, code: "not_eligible", message: "Add at least one product photo to compare its design with your furniture." };
      }
    }
    if ((await listRuns(paths, caseId)).some((r) => r.status === "running")) {
      return { ok: false, status: 409, code: "already_running", message: "A sourcing run for this reference is already in progress." };
    }
    const outcome = await runOrchestration(curatedOfflineConfig(paths, caseId, deps.runner === undefined ? defaultRunner(paths) : deps.runner, deps.now, choice), "run");
    return { ok: true, runId: outcome.runId!, status: outcome.status };
  } finally {
    inFlight.delete(caseId);
  }
}
