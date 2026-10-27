import { randomUUID } from "node:crypto";
import type { CandidateListing, VisualMatchAssessment } from "../../domain";
import type { ModelResponseMeta } from "../../understanding/openai/errors";
import { VisionModelError, type VisionModelErrorCategory } from "../../understanding/openai/errors";
import { visualMatchAssessmentSchema } from "../../validation/assessment";
import { summarizeIssues } from "../../validation/issues";
import type { RejectedImage } from "../../shortlisting/types";
import type { VisualVerificationRequest, VisualVerificationService } from "../types";
import type { EvidenceImage, VerificationEvidenceProvider } from "./evidence";
import { formatReferenceObservations, VISUAL_VERIFICATION_INSTRUCTIONS_VERSION } from "./instructions";
import { mapRawVerificationToAssessment } from "./mapping";
import type { RawVisualVerification } from "./raw-response";
import type { VisualVerificationModelClient } from "./verification-client";

/** Hard cap on paid model requests. There is no unlimited default. */
export class PaidRequestBudget {
  private used = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 0) throw new RangeError("The paid-request cap must be a whole number ≥ 0");
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return this.max - this.used;
  }

  /** Reserves one request; false when the cap is reached. */
  tryTake(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}

/** After these, further requests in the same run would fail the same way (and may still cost money). */
export const FATAL_CATEGORIES: ReadonlySet<VisionModelErrorCategory> = new Set([
  "authentication",
  "permission",
  "model_not_found",
  "rate_limit",
]);

export interface PairAttempt {
  /** Random id of this paid attempt; keeps record files unique. */
  attemptId: string;
  listing: CandidateListing;
  reference: Omit<EvidenceImage, "content">;
  candidate: Omit<EvidenceImage, "content">;
  requestedAt: string;
}

export type PairOutcome =
  | ({ status: "succeeded"; assessment: VisualMatchAssessment; raw: RawVisualVerification; response: ModelResponseMeta; completedAt: string } & PairAttempt)
  | ({
      status: "refused" | "incomplete" | "invalid_output" | "failed";
      category: VisionModelErrorCategory;
      message: string;
      requestId?: string;
      response?: ModelResponseMeta;
      /** Schema-valid output that failed consistency checks, kept for audit. */
      raw?: RawVisualVerification;
      completedAt: string;
    } & PairAttempt)
  | { status: "no_usable_image"; listing: CandidateListing; rejected: RejectedImage[] }
  | { status: "not_requested"; listing: CandidateListing; reason: "budget_exhausted" | "stopped_after_fatal_error" };

export interface OpenAIVisualVerificationServiceOptions {
  client: VisualVerificationModelClient;
  evidence: VerificationEvidenceProvider;
  budget: PaidRequestBudget;
  /** Called just before each paid request; if it throws, the request is not sent. */
  onRequestStart?: (attempt: PairAttempt) => Promise<void>;
  /** Called with every outcome, in listing order. */
  onOutcome?: (outcome: PairOutcome) => Promise<void>;
  now?: () => Date;
  generateId?: () => string;
}

const strip = (img: EvidenceImage): Omit<EvidenceImage, "content"> => ({
  ref: img.ref,
  uri: img.uri,
  sha256: img.sha256,
  mimeType: img.mimeType,
  width: img.width,
  height: img.height,
});

/**
 * Real detailed visual verification with GPT-6.1 Sol: one request per
 * reference/candidate pair, sequential, within a fixed request budget, with
 * no retries and no fallback model. Listings without a usable image, beyond
 * the budget, or whose request failed are left unassessed; nothing is
 * fabricated. Each request carries only the two images and the reference
 * fingerprint's visual observations.
 */
export class OpenAIVisualVerificationService implements VisualVerificationService {
  private readonly options: Required<Omit<OpenAIVisualVerificationServiceOptions, "onRequestStart" | "onOutcome">> &
    Pick<OpenAIVisualVerificationServiceOptions, "onRequestStart" | "onOutcome">;

  constructor(options: OpenAIVisualVerificationServiceOptions) {
    this.options = { now: () => new Date(), generateId: () => `va-${randomUUID()}`, ...options };
  }

  async verify(request: VisualVerificationRequest): Promise<VisualMatchAssessment[]> {
    const assessments: VisualMatchAssessment[] = [];
    let stopped = false;
    for (const listing of request.listings) {
      const outcome: PairOutcome = stopped
        ? { status: "not_requested", listing, reason: "stopped_after_fatal_error" }
        : await this.verifyListing(request, listing);
      if (outcome.status === "succeeded") assessments.push(outcome.assessment);
      if ("category" in outcome && FATAL_CATEGORIES.has(outcome.category)) stopped = true;
      await this.options.onOutcome?.(outcome);
    }
    return assessments;
  }

  private async verifyListing(request: VisualVerificationRequest, listing: CandidateListing): Promise<PairOutcome> {
    const { client, evidence, budget, now, generateId, onRequestStart } = this.options;
    const candidate = await evidence.candidate(listing);
    if ("unusable" in candidate) return { status: "no_usable_image", listing, rejected: candidate.unusable };
    const reference = await evidence.reference(request.reference);
    if (!budget.tryTake()) return { status: "not_requested", listing, reason: "budget_exhausted" };

    const attempt: PairAttempt = { attemptId: randomUUID().slice(0, 8), listing, reference: strip(reference), candidate: strip(candidate), requestedAt: now().toISOString() };
    await onRequestStart?.(attempt);

    let result;
    try {
      result = await client.comparePair({
        reference: reference.content,
        candidate: candidate.content,
        referenceObservations: formatReferenceObservations(request.fingerprint),
      });
    } catch (error) {
      const e = error instanceof VisionModelError ? error : new VisionModelError("unexpected", "Unexpected verification failure", { cause: error });
      const status = e.category === "refusal" ? "refused" : e.category === "incomplete" ? "incomplete" : e.category === "malformed_output" ? "invalid_output" : "failed";
      return { status, category: e.category, message: e.message, requestId: e.requestId, response: e.response, completedAt: now().toISOString(), ...attempt };
    }

    const completedAt = now().toISOString();
    const response: ModelResponseMeta = { responseId: result.responseId, responseModel: result.responseModel, usage: result.usage };
    try {
      const assessment = mapRawVerificationToAssessment(result.verification, {
        assessmentId: generateId(),
        referenceImageId: request.reference.id,
        fingerprintId: request.fingerprint.id,
        listingId: listing.id,
        candidateImageUri: candidate.uri,
        assessedAt: completedAt,
        // The API-reported model, set by OpenAI rather than model output.
        modelId: result.responseModel || client.settings.model,
        instructionsVersion: VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
        responseId: result.responseId,
      });
      const checked = visualMatchAssessmentSchema.safeParse(assessment);
      if (!checked.success) {
        throw new VisionModelError("malformed_output", `Mapped assessment failed validation: ${summarizeIssues(checked.error)}`);
      }
      if (checked.data.listingId !== listing.id || checked.data.referenceImageId !== request.reference.id) {
        throw new VisionModelError("malformed_output", "Mapped assessment is associated with the wrong listing or reference");
      }
      return { status: "succeeded", assessment: checked.data, raw: result.verification, response, completedAt, ...attempt };
    } catch (error) {
      if (!(error instanceof VisionModelError)) throw error;
      return { status: "invalid_output", category: error.category, message: error.message, response, raw: result.verification, completedAt, ...attempt };
    }
  }
}
