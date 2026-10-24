import { createHash } from "node:crypto";
import { z } from "zod";
import type { ImageContent } from "../image-input/image-content";
import { ImageInputError } from "../image-input/image-content";
import {
  FurnitureNotIdentifiedError,
  VisionModelError,
  type VisionModelErrorCategory,
} from "../understanding/openai/errors";
import type { ImageUnderstandingDetails } from "../understanding/openai/openai-image-understanding";
import type { VisionRequestSettings } from "../understanding/openai/vision-client";
import { dataSourceKindSchema, isoTimestampSchema } from "../validation/common";
import type { Assert } from "../validation/contract";
import { furnitureFingerprintSchema } from "../validation/fingerprint";

/**
 * One saved image-understanding run, written by `analyze:image --output`.
 * Holds the fingerprint or the typed reason there is none, plus request
 * settings and usage. Never holds image bytes, credentials or raw payloads.
 */

const VISION_ERROR_CATEGORIES = [
  "refusal",
  "incomplete",
  "missing_output",
  "malformed_output",
  "authentication",
  "permission",
  "model_not_found",
  "bad_request",
  "rate_limit",
  "timeout",
  "network",
  "server_error",
  "unexpected",
] as const satisfies readonly VisionModelErrorCategory[];

// Fails to compile if VisionModelErrorCategory gains a value not listed above.
export type _AllVisionErrorCategoriesListed = Assert<
  [Exclude<VisionModelErrorCategory, (typeof VISION_ERROR_CATEGORIES)[number]>] extends [never] ? true : false
>;

export const RUN_ERROR_CATEGORIES = [...VISION_ERROR_CATEGORIES, "image_input"] as const;
export type RunErrorCategory = (typeof RUN_ERROR_CATEGORIES)[number];

const nonNegativeInt = z.int().nonnegative();

export const tokenUsageSchema = z.strictObject({
  inputTokens: nonNegativeInt,
  /** Includes reasoning tokens. */
  outputTokens: nonNegativeInt,
  totalTokens: nonNegativeInt,
  reasoningTokens: nonNegativeInt.optional(),
});

const furnitureResult = z.strictObject({
  kind: z.literal("furniture_identified"),
  fingerprint: furnitureFingerprintSchema,
});

/** The model answered but reported no single furniture object: not an error. */
const notIdentifiedResult = z.strictObject({
  kind: z.literal("not_identified"),
  modelOutcome: z.enum(["no_furniture", "ambiguous_target", "unreadable_image"]),
  /** Model-written, untrusted, truncated. */
  modelReason: z.string(),
});

const errorResult = z.strictObject({
  kind: z.literal("error"),
  errorCategory: z.enum(RUN_ERROR_CATEGORIES),
  message: z.string(),
  status: z.int().nullable(),
  requestId: z.string().nullable(),
});

export const runRecordSchema = z
  .strictObject({
    recordType: z.literal("image_understanding_run"),
    schemaVersion: z.literal(1),
    /** Evaluation case this run belongs to; null for ad-hoc runs. */
    caseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).nullable(),
    recordedAt: isoTimestampSchema,
    /** "live" for real API runs; "mock" for synthetic fixtures. */
    dataSource: dataSourceKindSchema,
    image: z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      bytes: z.int().positive(),
    }),
    referenceId: z.string().min(1),
    request: z.strictObject({
      model: z.string().min(1),
      instructionsVersion: z.string().min(1),
      imageDetail: z.string().min(1),
      reasoningEffort: z.string().min(1),
      maxOutputTokens: z.int().positive(),
      timeoutMs: z.int().positive(),
    }),
    response: z.strictObject({
      responseId: z.string().nullable(),
      /** Model reported by the API; may be a dated snapshot. */
      responseModel: z.string().nullable(),
      usage: tokenUsageSchema.nullable(),
      durationMs: z.number().nonnegative().nullable(),
    }),
    result: z.discriminatedUnion("kind", [furnitureResult, notIdentifiedResult, errorResult]),
  })
  .superRefine((r, ctx) => {
    if (r.result.kind !== "furniture_identified") return;
    const fp = r.result.fingerprint;
    if (fp.source.dataSource !== r.dataSource) {
      ctx.addIssue({ code: "custom", path: ["result", "fingerprint", "source", "dataSource"], message: "Does not match record dataSource" });
    }
    if (!fp.referenceImageIds.includes(r.referenceId)) {
      ctx.addIssue({ code: "custom", path: ["result", "fingerprint", "referenceImageIds"], message: "Does not include referenceId" });
    }
  });

export type RunRecord = z.output<typeof runRecordSchema>;
export type RunResult = RunRecord["result"];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type RunOutcome = { ok: true; details: ImageUnderstandingDetails } | { ok: false; error: unknown };

export interface BuildRunRecordInput {
  caseId: string | null;
  recordedAt: string;
  dataSource: "live" | "mock";
  image: ImageContent;
  referenceId: string;
  settings: VisionRequestSettings;
  instructionsVersion: string;
  durationMs: number | null;
  outcome: RunOutcome;
}

/** Builds a record from a run outcome. Unknown errors keep only their name. */
export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const { settings, outcome } = input;
  let result: RunResult;
  let response: RunRecord["response"] = {
    responseId: null,
    responseModel: null,
    usage: null,
    durationMs: input.durationMs,
  };

  if (outcome.ok) {
    const { fingerprint, responseId, usage } = outcome.details;
    result = { kind: "furniture_identified", fingerprint };
    response = { ...response, responseId, responseModel: fingerprint.source.modelId ?? null, usage: usage ?? null };
  } else {
    const error = outcome.error;
    if (error instanceof FurnitureNotIdentifiedError || error instanceof VisionModelError) {
      if (error.response) {
        response = {
          ...response,
          responseId: error.response.responseId,
          responseModel: error.response.responseModel,
          usage: error.response.usage ?? null,
        };
      }
    }
    if (error instanceof FurnitureNotIdentifiedError) {
      result = { kind: "not_identified", modelOutcome: error.outcome, modelReason: error.modelReason };
    } else if (error instanceof VisionModelError) {
      result = {
        kind: "error",
        errorCategory: error.category,
        message: error.message,
        status: error.status ?? null,
        requestId: error.requestId ?? null,
      };
    } else if (error instanceof ImageInputError) {
      result = { kind: "error", errorCategory: "image_input", message: error.message, status: null, requestId: null };
    } else {
      const name = error instanceof Error ? error.name : "unknown error";
      result = { kind: "error", errorCategory: "unexpected", message: `Unexpected ${name}`, status: null, requestId: null };
    }
  }

  return {
    recordType: "image_understanding_run",
    schemaVersion: 1,
    caseId: input.caseId,
    recordedAt: input.recordedAt,
    dataSource: input.dataSource,
    image: { sha256: sha256Hex(input.image.bytes), mimeType: input.image.mimeType, bytes: input.image.bytes.length },
    referenceId: input.referenceId,
    request: {
      model: settings.model,
      instructionsVersion: input.instructionsVersion,
      imageDetail: settings.imageDetail,
      reasoningEffort: settings.reasoningEffort,
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
    },
    response,
    result,
  };
}
