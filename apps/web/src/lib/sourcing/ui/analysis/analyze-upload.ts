import { join } from "node:path";
import { buildRunRecord, runRecordSchema, type RunOutcome } from "../../evaluation/run-record";
import { ImageInputError, validateImageBytes, type ImageContent } from "../../image-input/image-content";
import { inspectImage } from "../../image-input/inspect";
import { createLocalReferenceImage, InMemoryImageContentProvider } from "../../image-input/local-file";
import { readImageUnderstandingConfig } from "../../understanding/openai/config";
import { FurnitureNotIdentifiedError, VisionModelError } from "../../understanding/openai/errors";
import { FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } from "../../understanding/openai/instructions";
import { OpenAIImageUnderstandingService } from "../../understanding/openai/openai-image-understanding";
import {
  DEFAULT_IMAGE_UNDERSTANDING_MODEL,
  DEFAULT_VISION_REQUEST_SETTINGS,
  OpenAIVisionClient,
  type VisionModelClient,
  type VisionRequestSettings,
} from "../../understanding/openai/vision-client";
import type { Paths } from "../data";
import { readConfined } from "../evidence";
import { getUpload, MAX_UPLOAD_BYTES, type UploadRecord } from "../uploads";
import {
  attemptKeyFor,
  caseIdForUpload,
  effectiveState,
  listAttempts,
  readAttemptRecord,
  reserveAttempt,
  saveAttempt,
  writeAttemptRecord,
  type AnalysisAttempt,
  type AnalysisRequest,
  type AttemptState,
} from "./attempts";
import { caseIdInUse, registerReference, RegistrationError } from "./register";

/**
 * One explicitly confirmed GPT-6 Luna analysis of one staged upload, through
 * the existing image-understanding service, saved in the existing run-record
 * format and registered as a reference. Nothing here searches marketplaces,
 * runs SigLIP or Sol, retries a request, or accepts a model id, path or key
 * from the browser.
 */

/** The web analysis always uses Luna with the established CLI request settings. */
export function webAnalysisSettings(): VisionRequestSettings {
  return { ...DEFAULT_VISION_REQUEST_SETTINGS, model: DEFAULT_IMAGE_UNDERSTANDING_MODEL };
}

export function analysisRequest(settings = webAnalysisSettings()): AnalysisRequest {
  const { model, imageDetail, reasoningEffort, maxOutputTokens, timeoutMs } = settings;
  return { model, instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION, imageDetail, reasoningEffort, maxOutputTokens, timeoutMs };
}

export type PreflightProblem =
  | "unknown_upload"
  | "missing_image"
  | "changed"
  | "invalid_path"
  | "too_large"
  | "unsupported_format"
  | "corrupt"
  | "dimensions"
  | "case_collision"
  | "api_key_missing";

export const PREFLIGHT_MESSAGES: Record<PreflightProblem, string> = {
  unknown_upload: "This upload doesn't exist.",
  missing_image: "The saved photo is missing.",
  changed: "The saved photo changed after it was uploaded, so it won't be analyzed.",
  invalid_path: "The saved photo isn't stored where it should be, so it won't be analyzed.",
  too_large: "The saved photo is larger than 10 MB.",
  unsupported_format: "The saved photo isn't a PNG, JPEG or WebP image.",
  corrupt: "The saved photo appears to be corrupted.",
  dimensions: "The saved photo's size doesn't match what was recorded at upload.",
  case_collision: "A saved reference with this photo's identity already exists, so nothing will be overwritten.",
  api_key_missing: "Analysis isn't set up on this computer: OPENAI_API_KEY is not configured on the server.",
};

export type Preflight =
  | { ok: true; upload: UploadRecord; content: ImageContent; request: AnalysisRequest; attemptKey: string; caseId: string; referenceId: string }
  | { ok: false; problem: PreflightProblem; message: string; upload: UploadRecord | null };

/**
 * Re-checks the staged photo exactly as recorded at upload: confined path, no
 * symlinks, size, SHA-256, real format and dimensions. Makes no network request.
 */
export async function preflightUpload(paths: Paths, uploadId: string, env: Record<string, string | undefined> = process.env, opts: { checkCase?: boolean } = {}): Promise<Preflight> {
  const fail = (problem: PreflightProblem, upload: UploadRecord | null = null): Preflight => ({ ok: false, problem, message: PREFLIGHT_MESSAGES[problem], upload });
  const upload = await getUpload(paths, uploadId);
  if (!upload) return fail("unknown_upload");
  if (upload.bytes > MAX_UPLOAD_BYTES) return fail("too_large", upload);
  const read = await readConfined(join(paths.uploads, upload.id), upload.file, upload.sha256);
  if (!read.ok) {
    const problem: PreflightProblem = read.code === "missing_image" ? "missing_image" : read.code === "changed" ? "changed" : read.code === "too_large" ? "too_large" : read.code === "unsupported_format" ? "unsupported_format" : "invalid_path";
    return fail(problem, upload);
  }
  if (read.bytes.length > MAX_UPLOAD_BYTES) return fail("too_large", upload);
  let content: ImageContent;
  try {
    content = validateImageBytes(read.bytes, MAX_UPLOAD_BYTES);
    const { width, height } = inspectImage(read.bytes);
    if (content.mimeType !== upload.mimeType) return fail("unsupported_format", upload);
    if (width !== upload.width || height !== upload.height) return fail("dimensions", upload);
  } catch (error) {
    if (error instanceof ImageInputError) return fail(/Corrupted/.test(error.message) ? "corrupt" : error.code === "too_large" ? "too_large" : "unsupported_format", upload);
    throw error;
  }
  const caseId = caseIdForUpload(upload.id);
  if (opts.checkCase !== false && (await caseIdInUse(paths, caseId))) return fail("case_collision", upload);
  if (!readImageUnderstandingConfig(env).apiKey) return fail("api_key_missing", upload);
  const request = analysisRequest();
  return {
    ok: true,
    upload,
    content,
    request,
    attemptKey: attemptKeyFor(upload.id, upload.sha256, request),
    caseId,
    referenceId: createLocalReferenceImage(content, upload.uploadedAt).id,
  };
}

export type AnalysisStatus =
  | { state: "ready"; attemptKey: string; request: AnalysisRequest; previous: AnalysisAttempt | null }
  | { state: "unavailable"; problem: PreflightProblem; message: string; previous: AnalysisAttempt | null }
  | { state: Exclude<AttemptState, "reserved" | "not_sent"> | "analyzing"; attempt: AnalysisAttempt }
  | { state: "blocked"; message: string };

/** The upload's analysis state for pages and polling. Reads files only. */
export async function getAnalysisStatus(paths: Paths, uploadId: string, env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<AnalysisStatus> {
  const { attempts, unreadable } = await listAttempts(paths, uploadId);
  if (unreadable.length) return { state: "blocked", message: "An analysis record for this photo can't be read, so no new analysis will start. Check the upload folder." };
  const latest = attempts.at(-1) ?? null;
  if (latest) {
    const state = effectiveState(latest, now);
    if (state === "reserved" || state === "sending") return { state: "analyzing", attempt: latest };
    if (state !== "not_sent") return { state, attempt: latest };
  }
  const pre = await preflightUpload(paths, uploadId, env);
  return pre.ok ? { state: "ready", attemptKey: pre.attemptKey, request: pre.request, previous: latest } : { state: "unavailable", problem: pre.problem, message: pre.message, previous: latest };
}

export interface AnalyzeDeps {
  env?: Record<string, string | undefined>;
  /** Builds the provider client. Defaults to the real SDK client (one request, no retries). */
  createVision?: (apiKey: string, settings: VisionRequestSettings) => VisionModelClient;
  now?: () => Date;
  clock?: () => number;
}

export type AnalyzeOutcome =
  | { ok: true; attempt: AnalysisAttempt }
  | { ok: false; status: 400 | 404 | 409 | 422 | 503; code: string; message: string; attempt?: AnalysisAttempt | null };

const defaultCreateVision: NonNullable<AnalyzeDeps["createVision"]> = (apiKey, settings) => OpenAIVisionClient.fromApiKey(apiKey, settings.model);

/**
 * Decorates the provider so the journal says "sending" before the request
 * leaves, and so a second request through it is impossible.
 */
class OneShotVision implements VisionModelClient {
  sent = false;
  constructor(
    private readonly inner: VisionModelClient,
    private readonly beforeSend: () => Promise<void>,
  ) {}
  get settings() {
    return this.inner.settings;
  }
  async analyzeImage(image: ImageContent) {
    if (this.sent) throw new Error("Only one request is allowed per confirmed analysis");
    await this.beforeSend();
    this.sent = true;
    return this.inner.analyzeImage(image);
  }
}

/** Errors with no response at all: the request may or may not have reached OpenAI and been charged. */
const UNCERTAIN_CATEGORIES = new Set(["timeout", "network", "unexpected"]);

/** In-process guard in addition to the durable reservation (cheap early refusal for double clicks). */
const inFlight = new Set<string>();

/**
 * Runs one confirmed analysis. `confirmedKey` must equal the key of the
 * current photo and configuration, so a confirmation cannot be replayed
 * against a changed photo or different settings.
 */
export async function analyzeUpload(paths: Paths, uploadId: string, confirmedKey: string, deps: AnalyzeDeps = {}): Promise<AnalyzeOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  if (inFlight.has(uploadId)) return { ok: false, status: 409, code: "in_progress", message: "This photo is already being analyzed." };
  inFlight.add(uploadId);
  try {
    const status = await getAnalysisStatus(paths, uploadId, env, now().getTime());
    if (status.state === "blocked") return { ok: false, status: 409, code: "blocked", message: status.message };
    if (status.state === "unavailable") return { ok: false, status: status.problem === "unknown_upload" ? 404 : status.problem === "api_key_missing" ? 503 : 422, code: status.problem, message: status.message };
    if (status.state !== "ready") {
      return { ok: false, status: 409, code: status.state === "analyzing" ? "in_progress" : "already_attempted", message: "This photo already has an analysis attempt. A new paid request is not sent automatically.", attempt: status.attempt };
    }
    if (confirmedKey !== status.attemptKey) return { ok: false, status: 409, code: "confirmation_mismatch", message: "The photo or analysis settings changed since you confirmed. Review and confirm again." };

    const pre = await preflightUpload(paths, uploadId, env);
    if (!pre.ok) return { ok: false, status: pre.problem === "api_key_missing" ? 503 : 422, code: pre.problem, message: pre.message };
    const reserved = await reserveAttempt(
      paths,
      { uploadId, attemptKey: pre.attemptKey, caseId: pre.caseId, referenceId: pre.referenceId, image: { sha256: pre.upload.sha256, mimeType: pre.upload.mimeType, bytes: pre.upload.bytes, width: pre.upload.width, height: pre.upload.height }, request: pre.request },
      now(),
    );
    if (!reserved.ok) return { ok: false, status: 409, code: reserved.reason, message: "This photo already has an analysis attempt. A new paid request is not sent automatically.", attempt: reserved.existing };
    return await runAttempt(paths, reserved.attempt, pre.content, readImageUnderstandingConfig(env).apiKey!, { ...deps, now, clock });
  } finally {
    inFlight.delete(uploadId);
  }
}

async function runAttempt(
  paths: Paths,
  reservedAttempt: AnalysisAttempt,
  content: ImageContent,
  apiKey: string,
  deps: Required<Pick<AnalyzeDeps, "now" | "clock">> & AnalyzeDeps,
): Promise<AnalyzeOutcome> {
  let attempt = reservedAttempt;
  const settings = webAnalysisSettings();
  const reference = createLocalReferenceImage(content, reservedAttempt.reservedAt);
  let vision: OneShotVision | null = null;
  let outcome: RunOutcome;
  let started = 0;
  try {
    const images = new InMemoryImageContentProvider();
    images.register(reference.id, content);
    vision = new OneShotVision((deps.createVision ?? defaultCreateVision)(apiKey, settings), async () => {
      attempt = await saveAttempt(paths, { ...attempt, state: "sending", sendStartedAt: deps.now().toISOString() }, deps.now());
      started = deps.clock();
    });
    const service = new OpenAIImageUnderstandingService({ images, vision, now: deps.now });
    outcome = { ok: true, details: await service.analyzeWithDetails(reference) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const durationMs = vision?.sent ? Math.max(0, Math.round(deps.clock() - started)) : null;
  const finishedAt = deps.now().toISOString();

  if (!vision?.sent) {
    // Nothing left this computer: record why, and allow a new confirmed attempt.
    const message = outcome.ok ? "No request was sent" : outcome.error instanceof Error ? `${outcome.error.name}: ${outcome.error.message}`.slice(0, 300) : "Unknown error before sending";
    attempt = await saveAttempt(paths, { ...attempt, state: "not_sent", finishedAt, outcome: { kind: "error", modelOutcome: null, modelReason: null, errorCategory: "internal", message, status: null, requestId: null } }, deps.now());
    return { ok: false, status: 503, code: "not_sent", message: "The analysis could not start. No request was sent to OpenAI.", attempt };
  }

  const record = runRecordSchema.parse(
    buildRunRecord({
      caseId: attempt.caseId,
      recordedAt: finishedAt,
      dataSource: "live",
      image: content,
      referenceId: reference.id,
      settings,
      instructionsVersion: attempt.request.instructionsVersion,
      durationMs,
      outcome,
    }),
  );
  const result = record.result;
  const uncertain = !outcome.ok && !(outcome.error instanceof FurnitureNotIdentifiedError) && !(outcome.error instanceof VisionModelError && (outcome.error.response || !UNCERTAIN_CATEGORIES.has(outcome.error.category)));
  const state: AttemptState = result.kind === "furniture_identified" ? "registration_pending" : result.kind === "not_identified" ? "not_identified" : uncertain ? "uncertain" : "failed";

  const recordFile = await writeAttemptRecord(paths, attempt, record);
  attempt = await saveAttempt(
    paths,
    {
      ...attempt,
      state,
      finishedAt,
      recordFile,
      response: record.response,
      outcome: {
        kind: result.kind,
        modelOutcome: result.kind === "not_identified" ? result.modelOutcome : null,
        modelReason: result.kind === "not_identified" ? result.modelReason : null,
        errorCategory: result.kind === "error" ? result.errorCategory : null,
        message: result.kind === "error" ? result.message : null,
        status: result.kind === "error" ? result.status : null,
        requestId: result.kind === "error" ? result.requestId : null,
      },
    },
    deps.now(),
  );
  if (state !== "registration_pending") return { ok: true, attempt };
  return finishRegistration(paths, attempt, deps.now);
}

/**
 * Registers the saved result of a paid attempt as a reference. Makes no
 * request; safe to repeat after a failed registration.
 */
export async function finishRegistration(paths: Paths, attempt: AnalysisAttempt, now: () => Date = () => new Date()): Promise<AnalyzeOutcome> {
  if (attempt.state !== "registration_pending") return { ok: false, status: 409, code: "not_pending", message: "There is nothing left to save for this analysis.", attempt };
  const upload = await getUpload(paths, attempt.uploadId);
  if (!upload || upload.sha256 !== attempt.image.sha256) return { ok: false, status: 409, code: "changed", message: "The uploaded photo no longer matches the analysis.", attempt };
  try {
    const record = runRecordSchema.parse(await readAttemptRecord(paths, attempt));
    const reg = await registerReference(paths, record, attempt.caseId, join(paths.uploads, upload.id, upload.file));
    const done = await saveAttempt(paths, { ...attempt, state: "analyzed", predictionFile: reg.predictionFile, imageMapEntry: reg.imageMapEntry, problem: null }, now());
    return { ok: true, attempt: done };
  } catch (error) {
    const message = error instanceof RegistrationError ? error.message : error instanceof Error ? error.message.slice(0, 300) : "unknown problem";
    const kept = await saveAttempt(paths, { ...attempt, problem: message }, now());
    return { ok: false, status: 409, code: error instanceof RegistrationError ? error.code : "registration_failed", message: "The analysis was saved, but it couldn't be added to your references yet.", attempt: kept };
  }
}

export async function finishPendingRegistration(paths: Paths, uploadId: string): Promise<AnalyzeOutcome> {
  const latest = (await listAttempts(paths, uploadId)).attempts.at(-1);
  if (!latest) return { ok: false, status: 404, code: "no_attempt", message: "This photo has not been analyzed." };
  return finishRegistration(paths, latest);
}
