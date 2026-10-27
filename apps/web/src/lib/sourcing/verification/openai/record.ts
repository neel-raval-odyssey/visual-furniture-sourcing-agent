import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataSourceKindSchema, isoTimestampSchema } from "../../validation/common";
import { visualMatchAssessmentSchema } from "../../validation/assessment";
import { summarizeIssues } from "../../validation/issues";
import type { PairAttempt, PairOutcome } from "./openai-visual-verification";
import { rawVisualVerificationSchema } from "./raw-response";
import type { VerificationRequestSettings } from "./verification-client";

/**
 * One private record per paid verification attempt, stored as
 * <dir>/<case>/<listing id>/<model>__<instructions>__<requested at>__<attempt id>.json.
 * Files are never overwritten by another attempt: a record is created as
 * "requested" before the request is sent and replaced atomically by its own
 * final state. Records hold hashes and manifest references, never image bytes,
 * base64 data, local paths or credentials.
 */

export const RECORD_STATUSES = ["requested", "succeeded", "refused", "incomplete", "invalid_output", "failed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const imageSchema = z.strictObject({
  ref: z.string().min(1),
  uri: z.string().min(1),
  sha256,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  width: z.int().positive(),
  height: z.int().positive(),
});

export const verificationRecordSchema = z
  .strictObject({
    recordType: z.literal("visual_verification_run"),
    schemaVersion: z.literal(1),
    status: z.enum(RECORD_STATUSES),
    attemptId: z.string().regex(/^[0-9a-f]{8}$/),
    caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    dataSource: dataSourceKindSchema,
    referenceImageId: z.string().min(1),
    fingerprintId: z.string().min(1),
    listingId: z.string().min(1),
    marketplaceProductId: z.string().nullable(),
    referenceImage: imageSchema,
    candidateImage: imageSchema,
    request: z.strictObject({
      model: z.string().min(1),
      instructionsVersion: z.string().min(1),
      imageDetail: z.literal("high"),
      reasoningEffort: z.literal("medium"),
      maxOutputTokens: z.int().positive(),
      timeoutMs: z.int().positive(),
      store: z.literal(false),
      tools: z.literal("none"),
      automaticRetries: z.literal(0),
    }),
    requestedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable(),
    response: z
      .strictObject({
        responseId: z.string().min(1),
        responseModel: z.string(),
        usage: z
          .strictObject({
            inputTokens: z.int().nonnegative(),
            outputTokens: z.int().nonnegative(),
            totalTokens: z.int().nonnegative(),
            reasoningTokens: z.int().nonnegative().nullable(),
          })
          .nullable(),
      })
      .nullable(),
    error: z.strictObject({ category: z.string().min(1), message: z.string(), requestId: z.string().nullable() }).nullable(),
    rawVerification: rawVisualVerificationSchema.nullable(),
    assessment: visualMatchAssessmentSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (r.status === "succeeded" && (!r.assessment || !r.rawVerification || !r.response || !r.completedAt)) {
      issue("a succeeded record needs an assessment, the raw verification, the response and a completion time");
    }
    if (r.status !== "succeeded" && r.assessment) issue("only succeeded records may hold an assessment");
    if (r.status === "requested" && (r.completedAt || r.response || r.error)) issue("a requested record has no result yet");
    if (!["succeeded", "requested"].includes(r.status) && !r.error) issue("an unsuccessful record needs an error");
    if (r.assessment) {
      const a = r.assessment;
      if (a.listingId !== r.listingId || a.referenceImageId !== r.referenceImageId || a.fingerprintId !== r.fingerprintId) {
        issue("the assessment is associated with a different listing, reference or fingerprint");
      }
    }
  });

export type VerificationRecord = z.output<typeof verificationRecordSchema>;

export interface RecordContext {
  caseId: string;
  dataSource: "mock" | "live";
  fingerprintId: string;
  settings: VerificationRequestSettings;
  instructionsVersion: string;
}

const toRecordImage = (img: PairAttempt["reference"]) => ({
  ref: img.ref,
  uri: img.uri,
  sha256: img.sha256,
  mimeType: img.mimeType,
  width: img.width,
  height: img.height,
});

function baseRecord(ctx: RecordContext, attempt: PairAttempt) {
  return {
    recordType: "visual_verification_run" as const,
    schemaVersion: 1 as const,
    attemptId: attempt.attemptId,
    caseId: ctx.caseId,
    dataSource: ctx.dataSource,
    referenceImageId: attempt.reference.uri,
    fingerprintId: ctx.fingerprintId,
    listingId: attempt.listing.id,
    marketplaceProductId: attempt.listing.marketplaceProductId ?? null,
    referenceImage: toRecordImage(attempt.reference),
    candidateImage: toRecordImage(attempt.candidate),
    request: {
      model: ctx.settings.model,
      instructionsVersion: ctx.instructionsVersion,
      imageDetail: ctx.settings.imageDetail,
      reasoningEffort: ctx.settings.reasoningEffort,
      maxOutputTokens: ctx.settings.maxOutputTokens,
      timeoutMs: ctx.settings.timeoutMs,
      store: false as const,
      tools: "none" as const,
      automaticRetries: 0 as const,
    },
    requestedAt: attempt.requestedAt,
  };
}

export function pendingRecord(ctx: RecordContext, attempt: PairAttempt): VerificationRecord {
  return { ...baseRecord(ctx, attempt), status: "requested", completedAt: null, response: null, error: null, rawVerification: null, assessment: null };
}

/** Final record for an attempted request. Returns null for outcomes without a request. */
export function finalRecord(ctx: RecordContext, outcome: PairOutcome): VerificationRecord | null {
  if (outcome.status === "no_usable_image" || outcome.status === "not_requested") return null;
  const response = outcome.response
    ? {
        responseId: outcome.response.responseId,
        responseModel: outcome.response.responseModel,
        usage: outcome.response.usage
          ? { ...outcome.response.usage, reasoningTokens: outcome.response.usage.reasoningTokens ?? null }
          : null,
      }
    : null;
  const base = { ...baseRecord(ctx, outcome), completedAt: outcome.completedAt, response };
  if (outcome.status === "succeeded") {
    return { ...base, status: "succeeded", error: null, rawVerification: outcome.raw, assessment: outcome.assessment };
  }
  return {
    ...base,
    status: outcome.status,
    error: { category: outcome.category, message: outcome.message, requestId: outcome.requestId ?? null },
    rawVerification: outcome.raw ?? null,
    assessment: null,
  };
}

export interface VerificationKey {
  caseId: string;
  listingId: string;
  referenceSha256: string;
  candidateSha256: string;
  model: string;
  instructionsVersion: string;
  imageDetail: string;
  reasoningEffort: string;
}

/** Identity of a verification: same pair, same images, same model settings and instructions. */
export function verificationKey(k: VerificationKey): string {
  return JSON.stringify([k.caseId, k.listingId, k.referenceSha256, k.candidateSha256, k.model, k.instructionsVersion, k.imageDetail, k.reasoningEffort]);
}

export function recordKey(r: VerificationRecord): string {
  return verificationKey({
    caseId: r.caseId,
    listingId: r.listingId,
    referenceSha256: r.referenceImage.sha256,
    candidateSha256: r.candidateImage.sha256,
    model: r.request.model,
    instructionsVersion: r.request.instructionsVersion,
    imageDetail: r.request.imageDetail,
    reasoningEffort: r.request.reasoningEffort,
  });
}

const slug = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, "-");

export function recordPath(dir: string, r: Pick<VerificationRecord, "caseId" | "listingId" | "request" | "requestedAt" | "attemptId">): string {
  const stamp = r.requestedAt.replace(/[:.]/g, "-");
  return join(dir, r.caseId, slug(r.listingId), `${slug(r.request.model)}__${slug(r.request.instructionsVersion)}__${stamp}__${r.attemptId}.json`);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, { flag: "wx" });
  await rename(tmp, path);
}

/** Creates the "requested" record; refuses to replace an existing file. */
export async function writePendingRecord(dir: string, record: VerificationRecord): Promise<string> {
  const path = recordPath(dir, record);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(verificationRecordSchema.parse(record), null, 2)}\n`, { flag: "wx" });
  return path;
}

/** Replaces a record's own pending file with its final state (atomic rename). */
export async function writeFinalRecord(dir: string, record: VerificationRecord): Promise<string> {
  const path = recordPath(dir, record);
  await mkdir(join(path, ".."), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(verificationRecordSchema.parse(record), null, 2)}\n`);
  return path;
}

export interface LoadedRecords {
  records: { file: string; record: VerificationRecord }[];
  /** Files that could not be read or validated (never silently dropped). */
  problems: { file: string; detail: string }[];
}

/** Loads every record for a case. A missing folder means no records. */
export async function loadVerificationRecords(dir: string, caseId: string): Promise<LoadedRecords> {
  const caseDir = join(dir, caseId);
  const out: LoadedRecords = { records: [], problems: [] };
  let listings: string[];
  try {
    listings = (await readdir(caseDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return out;
  }
  for (const listing of listings) {
    const files = (await readdir(join(caseDir, listing))).filter((f) => f.endsWith(".json")).sort();
    for (const name of files) {
      const file = join(caseId, listing, name);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(caseDir, listing, name), "utf8"));
      } catch {
        out.problems.push({ file, detail: "not valid JSON" });
        continue;
      }
      const parsed = verificationRecordSchema.safeParse(raw);
      if (!parsed.success) {
        out.problems.push({ file, detail: summarizeIssues(parsed.error) });
        continue;
      }
      if (parsed.data.caseId !== caseId) {
        out.problems.push({ file, detail: `belongs to case "${parsed.data.caseId}"` });
        continue;
      }
      out.records.push({ file, record: parsed.data });
    }
  }
  return out;
}
