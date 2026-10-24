import { randomUUID } from "node:crypto";
import type { FurnitureFingerprint, ReferenceImage } from "../../domain";
import type { ReferenceImageContentProvider } from "../../image-input/image-content";
import { furnitureFingerprintSchema } from "../../validation/fingerprint";
import { summarizeIssues } from "../../validation/issues";
import type { ImageUnderstandingService } from "../types";
import { FurnitureNotIdentifiedError, VisionModelError } from "./errors";
import { mapRawAnalysisToFingerprint } from "./mapping";
import type { VisionModelClient, VisionTokenUsage } from "./vision-client";

export interface ImageUnderstandingDetails {
  fingerprint: FurnitureFingerprint;
  responseId: string;
  usage?: VisionTokenUsage;
}

export interface OpenAIImageUnderstandingServiceOptions {
  images: ReferenceImageContentProvider;
  vision: VisionModelClient;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Real image understanding: resolve image bytes → one model request →
 * validate raw output → map to a fingerprint with application-owned
 * provenance → validate the fingerprint. Failures are thrown, never replaced
 * with mock or default output.
 */
export class OpenAIImageUnderstandingService implements ImageUnderstandingService {
  private readonly options: Required<OpenAIImageUnderstandingServiceOptions>;

  constructor(options: OpenAIImageUnderstandingServiceOptions) {
    this.options = {
      now: () => new Date(),
      generateId: () => `fp-${randomUUID()}`,
      ...options,
    };
  }

  async analyze(reference: ReferenceImage): Promise<FurnitureFingerprint> {
    return (await this.analyzeWithDetails(reference)).fingerprint;
  }

  async analyzeWithDetails(reference: ReferenceImage): Promise<ImageUnderstandingDetails> {
    const { images, vision, now, generateId } = this.options;

    const image = await images.load(reference);
    const result = await vision.analyzeImage(image);

    const response = { responseId: result.responseId, responseModel: result.responseModel, usage: result.usage };

    try {
      const fingerprint = mapRawAnalysisToFingerprint(result.analysis, reference, {
        fingerprintId: generateId(),
        createdAt: now().toISOString(),
        // The API-reported model (set by OpenAI, not by model output), falling
        // back to the configured id.
        modelId: result.responseModel || vision.settings.model,
      });

      const checked = furnitureFingerprintSchema.safeParse(fingerprint);
      if (!checked.success) {
        throw new VisionModelError(
          "malformed_output",
          `Mapped fingerprint failed validation: ${summarizeIssues(checked.error)}`,
          { cause: checked.error },
        );
      }
      return { fingerprint: checked.data, responseId: result.responseId, usage: result.usage };
    } catch (error) {
      // Keep response metadata (tokens, id) on rejections and mapping failures.
      if (error instanceof FurnitureNotIdentifiedError || error instanceof VisionModelError) {
        error.response ??= response;
      }
      throw error;
    }
  }
}
