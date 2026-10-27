import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RUN_ERROR_CATEGORIES, tokenUsageSchema } from "../../evaluation/run-record";
import type { Paths } from "../data";
import { UPLOAD_ID } from "../uploads";

/**
 * Durable journal of paid image-analysis attempts for one staged upload
 * (evals/local/uploads/<id>/analysis/attempt-<n>.json). A journal is created
 * with an atomic exclusive operation before any request, marked "sending"
 * immediately before the single provider call, and never deleted: a refresh,
 * a second click, another process or a restarted server sees it and does not
 * send again. Journals hold settings, hashes, usage and outcomes; never image
 * bytes, keys or provider payloads.
 */

export const ATTEMPT_STATES = [
  /** Reserved; the request has not been sent yet. */
  "reserved",
  /** Marked immediately before the one provider call; outcome not yet known. */
  "sending",
  /** Fingerprint saved and the reference registered. */
  "analyzed",
  /** Paid result saved in the attempt folder, but registration did not finish. */
  "registration_pending",
  /** The model answered without identifying one furniture object. */
  "not_identified",
  /** OpenAI answered with an error or an unusable response. */
  "failed",
  /** The request may have been sent and charged, but no answer was received. */
  "uncertain",
  /** Failed before anything was sent; a new attempt may be confirmed. */
  "not_sent",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const analysisRequestSchema = z.strictObject({
  model: z.string().min(1),
  instructionsVersion: z.string().min(1),
  imageDetail: z.string().min(1),
  reasoningEffort: z.string().min(1),
  maxOutputTokens: z.int().positive(),
  timeoutMs: z.int().positive(),
});
export type AnalysisRequest = z.output<typeof analysisRequestSchema>;

export const attemptSchema = z.strictObject({
  recordType: z.literal("upload_analysis_attempt"),
  schemaVersion: z.literal(1),
  uploadId: z.string().regex(UPLOAD_ID),
  attempt: z.int().positive(),
  /** SHA-256 of upload id, image hash and request settings: what the user confirmed. */
  attemptKey: z.string().regex(/^[0-9a-f]{64}$/),
  caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  referenceId: z.string().min(1),
  image: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mimeType: z.string(), bytes: z.int().positive(), width: z.int().positive(), height: z.int().positive() }),
  request: analysisRequestSchema,
  state: z.enum(ATTEMPT_STATES),
  reservedAt: z.string(),
  sendStartedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
  response: z
    .strictObject({ responseId: z.string().nullable(), responseModel: z.string().nullable(), usage: tokenUsageSchema.nullable(), durationMs: z.number().nonnegative().nullable() })
    .nullable(),
  outcome: z
    .strictObject({
      kind: z.enum(["furniture_identified", "not_identified", "error"]),
      modelOutcome: z.enum(["no_furniture", "ambiguous_target", "unreadable_image"]).nullable(),
      /** Model-written, untrusted, truncated. */
      modelReason: z.string().nullable(),
      errorCategory: z.enum([...RUN_ERROR_CATEGORIES, "internal"]).nullable(),
      message: z.string().nullable(),
      status: z.int().nullable(),
      requestId: z.string().nullable(),
    })
    .nullable(),
  /** The standard run record for this attempt, relative to the upload folder. */
  recordFile: z.string().nullable(),
  /** Set once the reference is registered (repository-relative). */
  predictionFile: z.string().nullable(),
  imageMapEntry: z.string().nullable(),
  /** Why registration has not finished, when state is registration_pending. */
  problem: z.string().nullable(),
});
export type AnalysisAttempt = z.output<typeof attemptSchema>;

/** Stable key for "this upload, these bytes, this model and configuration". */
export function attemptKeyFor(uploadId: string, imageSha256: string, request: AnalysisRequest): string {
  const r = analysisRequestSchema.parse(request);
  const parts = [uploadId, imageSha256, r.model, r.instructionsVersion, r.imageDetail, r.reasoningEffort, String(r.maxOutputTokens), String(r.timeoutMs)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** A reference id that fits the existing case-id conventions, derived from the upload id. */
export const caseIdForUpload = (uploadId: string) => uploadId.toLowerCase();

const analysisDir = (paths: Paths, uploadId: string) => join(paths.uploads, uploadId, "analysis");
const attemptFile = (n: number) => `attempt-${n}.json`;
export const recordFileName = (n: number) => `attempt-${n}.record.json`;

/** Writes `text` to `path` only if nothing exists there, atomically (readers never see a partial file). */
export async function writeExclusive(path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { flag: "wx" });
  try {
    await link(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Replaces `path` atomically (write a temporary file, then rename over it). */
export async function writeReplace(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { flag: "wx" });
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export interface AttemptList {
  attempts: AnalysisAttempt[];
  /** Attempt files that could not be read or validated. They block new attempts. */
  unreadable: string[];
}

export async function listAttempts(paths: Paths, uploadId: string): Promise<AttemptList> {
  if (!UPLOAD_ID.test(uploadId)) return { attempts: [], unreadable: [] };
  let names: string[];
  try {
    names = (await readdir(analysisDir(paths, uploadId))).filter((n) => /^attempt-\d+\.json$/.test(n));
  } catch {
    return { attempts: [], unreadable: [] };
  }
  const attempts: AnalysisAttempt[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try {
      const parsed = attemptSchema.safeParse(JSON.parse(await readFile(join(analysisDir(paths, uploadId), name), "utf8")));
      if (parsed.success && parsed.data.uploadId === uploadId && name === attemptFile(parsed.data.attempt)) attempts.push(parsed.data);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { attempts: attempts.sort((a, b) => a.attempt - b.attempt), unreadable };
}

/** How long a "sending" or "reserved" journal may stay unchanged before it is treated as interrupted. */
export const staleAfterMs = (request: AnalysisRequest) => request.timeoutMs + 120_000;

/**
 * The state to act on and display. A "sending" journal that outlived the
 * request timeout (process restarted, response lost) is uncertain, never
 * resent; a "reserved" journal that never reached "sending" was not sent.
 */
export function effectiveState(a: AnalysisAttempt, now = Date.now()): AttemptState {
  const stale = now - Date.parse(a.updatedAt) > staleAfterMs(a.request);
  if (a.state === "sending" && stale) return "uncertain";
  if (a.state === "reserved" && stale) return "not_sent";
  return a.state;
}

export type Reservation = { ok: true; attempt: AnalysisAttempt } | { ok: false; reason: "in_progress" | "already_attempted" | "unreadable_attempt"; existing: AnalysisAttempt | null };

/**
 * Atomically reserves the next attempt. Only allowed when there is no attempt,
 * or the latest one was never sent. Two simultaneous reservations cannot both
 * succeed: the file is created with an exclusive link.
 */
export async function reserveAttempt(
  paths: Paths,
  fields: Pick<AnalysisAttempt, "uploadId" | "attemptKey" | "caseId" | "referenceId" | "image" | "request">,
  now = new Date(),
): Promise<Reservation> {
  const { attempts, unreadable } = await listAttempts(paths, fields.uploadId);
  if (unreadable.length) return { ok: false, reason: "unreadable_attempt", existing: null };
  const latest = attempts.at(-1) ?? null;
  if (latest) {
    const state = effectiveState(latest, now.getTime());
    if (state !== "not_sent") return { ok: false, reason: state === "reserved" || state === "sending" ? "in_progress" : "already_attempted", existing: latest };
  }
  const n = (latest?.attempt ?? 0) + 1;
  const at = now.toISOString();
  const attempt: AnalysisAttempt = attemptSchema.parse({
    recordType: "upload_analysis_attempt",
    schemaVersion: 1,
    ...fields,
    attempt: n,
    state: "reserved",
    reservedAt: at,
    sendStartedAt: null,
    finishedAt: null,
    updatedAt: at,
    response: null,
    outcome: null,
    recordFile: null,
    predictionFile: null,
    imageMapEntry: null,
    problem: null,
  });
  await mkdir(analysisDir(paths, fields.uploadId), { recursive: true });
  if (!(await writeExclusive(join(analysisDir(paths, fields.uploadId), attemptFile(n)), json(attempt)))) {
    const again = (await listAttempts(paths, fields.uploadId)).attempts.find((a) => a.attempt === n) ?? null;
    return { ok: false, reason: "in_progress", existing: again };
  }
  return { ok: true, attempt };
}

/** Persists a new version of an attempt (validated, atomic replace). */
export async function saveAttempt(paths: Paths, attempt: AnalysisAttempt, now = new Date()): Promise<AnalysisAttempt> {
  const next = attemptSchema.parse({ ...attempt, updatedAt: now.toISOString() });
  await writeReplace(join(analysisDir(paths, attempt.uploadId), attemptFile(attempt.attempt)), json(next));
  return next;
}

export async function writeAttemptRecord(paths: Paths, attempt: AnalysisAttempt, record: unknown): Promise<string> {
  const name = recordFileName(attempt.attempt);
  if (!(await writeExclusive(join(analysisDir(paths, attempt.uploadId), name), json(record)))) {
    throw new Error(`The record for attempt ${attempt.attempt} already exists`);
  }
  return `analysis/${name}`;
}

export async function readAttemptRecord(paths: Paths, attempt: AnalysisAttempt): Promise<unknown> {
  if (!attempt.recordFile || !/^analysis\/attempt-\d+\.record\.json$/.test(attempt.recordFile)) throw new Error("No saved record for this attempt");
  return JSON.parse(await readFile(join(paths.uploads, attempt.uploadId, attempt.recordFile), "utf8"));
}
