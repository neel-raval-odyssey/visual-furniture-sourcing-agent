import { describe, expect, it, vi } from "vitest";
import { MockAlibabaDiscoveryAdapter } from "../../discovery/mock/mock-alibaba-adapter";
import { createLocalReferenceImage, InMemoryImageContentProvider } from "../../image-input/local-file";
import { TEST_JPEG } from "../../image-input/test-fixtures";
import { SourcingPipelineError } from "../../pipeline/errors";
import { SourcingPipeline } from "../../pipeline/sourcing-pipeline";
import { ProvisionalRankingService } from "../../ranking/provisional-ranking";
import { furnitureFingerprintSchema } from "../../validation/fingerprint";
import { MockVisualVerificationService } from "../../verification/mock/mock-visual-verification";
import type { ImageUnderstandingService } from "../types";
import { FurnitureNotIdentifiedError, VisionModelError } from "./errors";
import { OpenAIImageUnderstandingService } from "./openai-image-understanding";
import type { RawVisionAnalysis } from "./raw-response";
import { SYNTHETIC_RAW_CHAIR, SYNTHETIC_RAW_NO_FURNITURE } from "./test-fixtures";
import { DEFAULT_VISION_REQUEST_SETTINGS, type VisionModelClient } from "./vision-client";

const content = { bytes: TEST_JPEG, mimeType: "image/jpeg" as const };
const reference = createLocalReferenceImage(content, "2026-10-24T09:59:00.000Z");
const NOW = new Date("2026-10-24T10:00:00.000Z");

function fakeVision(analysis: RawVisionAnalysis, responseModel = "gpt-6-luna"): VisionModelClient & { analyzeImage: ReturnType<typeof vi.fn> } {
  return {
    settings: { ...DEFAULT_VISION_REQUEST_SETTINGS, model: "gpt-6-luna" },
    analyzeImage: vi.fn(async () => ({
      analysis: structuredClone(analysis),
      responseModel,
      responseId: "resp_synthetic_1",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    })),
  };
}

function createService(vision: VisionModelClient) {
  const images = new InMemoryImageContentProvider();
  images.register(reference.id, content);
  return new OpenAIImageUnderstandingService({ images, vision, now: () => NOW, generateId: () => "fp-test-1" });
}

describe("OpenAIImageUnderstandingService", () => {
  it("implements ImageUnderstandingService and returns a valid live fingerprint", async () => {
    const vision = fakeVision(SYNTHETIC_RAW_CHAIR);
    const service: ImageUnderstandingService = createService(vision);
    const fingerprint = await service.analyze(reference);

    expect(furnitureFingerprintSchema.safeParse(fingerprint).success).toBe(true);
    expect(fingerprint).toMatchObject({
      id: "fp-test-1",
      referenceImageIds: [reference.id],
      category: "chair",
      createdAt: NOW.toISOString(),
      source: { kind: "model", dataSource: "live", modelId: "gpt-6-luna" },
    });
    expect(vision.analyzeImage).toHaveBeenCalledWith(content);
  });

  it("records the model reported by the API response", async () => {
    const service = createService(fakeVision(SYNTHETIC_RAW_CHAIR, "gpt-6-luna-2026-10-01"));
    expect((await service.analyze(reference)).source.modelId).toBe("gpt-6-luna-2026-10-01");
  });

  it("returns usage and response id with details", async () => {
    const details = await createService(fakeVision(SYNTHETIC_RAW_CHAIR)).analyzeWithDetails(reference);
    expect(details.responseId).toBe("resp_synthetic_1");
    expect(details.usage?.totalTokens).toBe(1200);
  });

  it("raises FurnitureNotIdentifiedError instead of fabricating a fingerprint", async () => {
    await expect(createService(fakeVision(SYNTHETIC_RAW_NO_FURNITURE)).analyze(reference)).rejects.toBeInstanceOf(
      FurnitureNotIdentifiedError,
    );
  });

  it("attaches response metadata to rejections so token usage is not lost", async () => {
    const error = await createService(fakeVision(SYNTHETIC_RAW_NO_FURNITURE)).analyze(reference).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FurnitureNotIdentifiedError);
    expect((error as FurnitureNotIdentifiedError).response).toEqual({
      responseId: "resp_synthetic_1",
      responseModel: "gpt-6-luna",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    });
  });

  it("does not call the model when the image cannot be resolved", async () => {
    const vision = fakeVision(SYNTHETIC_RAW_CHAIR);
    const service = new OpenAIImageUnderstandingService({ images: new InMemoryImageContentProvider(), vision });

    await expect(service.analyze(reference)).rejects.toMatchObject({ code: "unknown_reference" });
    expect(vision.analyzeImage).not.toHaveBeenCalled();
  });

  it("propagates model failures without substituting mock output", async () => {
    const vision = fakeVision(SYNTHETIC_RAW_CHAIR);
    vision.analyzeImage.mockRejectedValueOnce(new VisionModelError("rate_limit", "Rate limit or quota exceeded (429)"));
    await expect(createService(vision).analyze(reference)).rejects.toMatchObject({ category: "rate_limit" });
  });
});

describe("compatibility with SourcingPipeline", () => {
  const pipelineWith = (imageUnderstanding: ImageUnderstandingService) =>
    new SourcingPipeline({
      imageUnderstanding,
      discovery: new MockAlibabaDiscoveryAdapter({ now: () => NOW }),
      visualVerification: new MockVisualVerificationService(),
      ranking: new ProvisionalRankingService(),
    });

  it("runs as the image_understanding stage with the other stages mocked", async () => {
    const run = await pipelineWith(createService(fakeVision(SYNTHETIC_RAW_CHAIR))).run({ reference });

    expect(run.fingerprint.source.dataSource).toBe("live");
    expect(run.discovery.provider.dataSource).toBe("mock");
    expect(run.discovery.listings.length).toBeGreaterThan(0);
    expect(run.discovery.listings.every((l) => l.category === "chair")).toBe(true);
    expect(run.results).toHaveLength(run.discovery.listings.length);
    // The mock verifier only knows synthetic references, so nothing is assessed.
    expect(run.assessments).toEqual([]);
  });

  it("surfaces non-furniture outcomes as image_understanding failures", async () => {
    const error = await pipelineWith(createService(fakeVision(SYNTHETIC_RAW_NO_FURNITURE)))
      .run({ reference })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SourcingPipelineError);
    expect((error as SourcingPipelineError).stage).toBe("image_understanding");
    expect((error as SourcingPipelineError).cause).toBeInstanceOf(FurnitureNotIdentifiedError);
  });
});
