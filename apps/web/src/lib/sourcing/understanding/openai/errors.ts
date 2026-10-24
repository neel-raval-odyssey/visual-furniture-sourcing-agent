import type { RawAnalysisOutcome } from "./raw-response";
import type { VisionTokenUsage } from "./vision-client";

/**
 * Metadata of a model response that was received but could not be turned
 * into a fingerprint. Kept so evaluations can account for tokens and trace
 * the response. Contains no model output.
 */
export interface ModelResponseMeta {
  responseId: string;
  responseModel: string;
  usage?: VisionTokenUsage;
}

export type VisionModelErrorCategory =
  | "refusal"
  | "incomplete"
  | "missing_output"
  | "malformed_output"
  | "authentication"
  | "permission"
  | "model_not_found"
  | "bad_request"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server_error"
  | "unexpected";

/**
 * A failed model request or unusable model response. Messages are concise
 * and never include the image, the API key or the full provider payload.
 */
export class VisionModelError extends Error {
  readonly category: VisionModelErrorCategory;
  readonly status?: number;
  /** Provider request id, useful when contacting support. */
  readonly requestId?: string;
  /** Set when a response was received before the failure. */
  response?: ModelResponseMeta;

  constructor(
    category: VisionModelErrorCategory,
    message: string,
    details: { status?: number; requestId?: string; cause?: unknown; response?: ModelResponseMeta } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "VisionModelError";
    this.category = category;
    this.status = details.status;
    this.requestId = details.requestId;
    this.response = details.response;
  }
}

/**
 * The model answered, but did not identify one primary furniture object. No
 * fingerprint is produced for these outcomes.
 */
export class FurnitureNotIdentifiedError extends Error {
  readonly outcome: Exclude<RawAnalysisOutcome, "furniture_identified">;
  /** Model-written explanation, truncated. Untrusted text. */
  readonly modelReason: string;
  /** Attached by the service so token usage of a rejection is not lost. */
  response?: ModelResponseMeta;

  constructor(outcome: Exclude<RawAnalysisOutcome, "furniture_identified">, modelReason: string) {
    super(`No furniture fingerprint: model reported "${outcome}"`);
    this.name = "FurnitureNotIdentifiedError";
    this.outcome = outcome;
    this.modelReason = modelReason.slice(0, 300);
  }
}
