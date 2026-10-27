import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../discovery/providers/apify/run-journal";
import { summarizeIssues } from "../validation/issues";

/**
 * run.json of one sourcing orchestration attempt
 * (evals/local/sourcing-runs/<case>/<run id>/run.json). Written atomically
 * after every stage. Each attempt gets its own run id; `inputIdentity` (a hash
 * of every input that affects results) says whether two attempts are
 * comparable. It never holds credentials.
 *
 * Stage states:
 *   not_started → running → completed | reused | partial | blocked | failed | skipped
 * - reused: an existing, compatible output was used unchanged.
 * - partial: the stage produced output, but not for every candidate.
 * - blocked: a prerequisite (authorization, local model, missing input) is absent; nothing was attempted.
 * - skipped: nothing to do (e.g. no candidate has an image).
 */

export const STAGES = ["reference", "candidates", "image_evidence", "shortlist", "verification", "assembly"] as const;
export type StageName = (typeof STAGES)[number];
export const STAGE_STATES = ["not_started", "running", "completed", "reused", "partial", "blocked", "failed", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];

const stageSchema = z.strictObject({
  state: z.enum(STAGE_STATES),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Output file relative to the run folder, or a repo-relative path of a reused file. */
  output: z.string().nullable(),
  message: z.string().nullable(),
});

export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("curated"), manifest: z.string().min(1) }),
  z.strictObject({ kind: z.literal("provider-run"), discoveryRun: z.string().min(1) }),
  z.strictObject({ kind: z.literal("provider-live") }),
]);
export type CandidateSourceSpec = z.output<typeof sourceSchema>;

export const selectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("top-k"), k: z.int().positive() }),
]);
export type SelectionPolicy = z.output<typeof selectionSchema>;

export const sourcingRunSchema = z.strictObject({
  recordType: z.literal("sourcing_orchestration_run"),
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^src-[0-9TZ-]+-[0-9a-f]{6}$/),
  caseId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  resumedAt: z.array(z.string()),
  status: z.enum(["running", "completed", "partial", "blocked", "failed"]),
  inputIdentity: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  inputs: z.strictObject({
    source: sourceSchema,
    synthetic: z.boolean(),
    selection: selectionSchema,
    siglip: z.strictObject({ modelId: z.string(), allowRecompute: z.boolean(), shortlist: z.string().nullable() }),
    sol: z.strictObject({ model: z.string(), instructionsVersion: z.string(), imageDetail: z.string(), reasoningEffort: z.string() }),
    preferLatestVerification: z.boolean(),
  }),
  /** Filled as stages complete. */
  resolved: z.strictObject({
    referenceImageId: z.string().nullable(),
    referenceSha256: z.string().nullable(),
    fingerprintId: z.string().nullable(),
    manifestSha256: z.string().nullable(),
    candidateImages: z.record(z.string(), z.string().nullable()),
  }),
  /** Nothing external is authorized by this command; recorded explicitly. */
  authorization: z.strictObject({
    externalDiscovery: z.literal("not_authorized"),
    remoteImageDownload: z.literal("not_authorized"),
    paidVerification: z.literal("not_authorized"),
  }),
  externalRequests: z.strictObject({ marketplace: z.literal(0), imageDownloads: z.literal(0), paidModel: z.literal(0) }),
  stages: z.record(z.enum(STAGES), stageSchema),
});
export type SourcingRunJournal = z.output<typeof sourcingRunSchema>;

export function newRunId(now: Date): string {
  return `src-${now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}-${randomUUID().slice(0, 6)}`;
}

export function emptyStages(): SourcingRunJournal["stages"] {
  return Object.fromEntries(STAGES.map((s) => [s, { state: "not_started", startedAt: null, finishedAt: null, output: null, message: null }])) as SourcingRunJournal["stages"];
}

/** Stable hash of everything that determines the result (not timestamps). */
export function computeInputIdentity(journal: Pick<SourcingRunJournal, "caseId" | "inputs" | "resolved">): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical({ caseId: journal.caseId, inputs: journal.inputs, resolved: journal.resolved }))).digest("hex");
}

export async function saveRunJournal(runDir: string, journal: SourcingRunJournal): Promise<void> {
  await writeJsonAtomic(join(runDir, "run.json"), sourcingRunSchema.parse(journal));
}

export class RunJournalError extends Error {}

export async function loadRunJournal(runDir: string): Promise<SourcingRunJournal> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  } catch {
    throw new RunJournalError("No readable run.json in that sourcing run folder");
  }
  const parsed = sourcingRunSchema.safeParse(raw);
  if (!parsed.success) throw new RunJournalError(`Sourcing run.json is invalid: ${summarizeIssues(parsed.error)}`);
  return parsed.data;
}
