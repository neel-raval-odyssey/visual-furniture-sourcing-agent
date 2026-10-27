import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importCuratedCandidates } from "../discovery/curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import { IMAGE_SELECTION_POLICY } from "../shortlisting/types";
import { sha256, TEST_CASE, testManifest, writeTestCase } from "../shortlisting/test-fixtures";
import { VISUAL_VERIFICATION_INSTRUCTIONS_VERSION } from "../verification/openai/instructions";
import { mapRawVerificationToAssessment } from "../verification/openai/mapping";
import type { RawVisualVerification } from "../verification/openai/raw-response";
import { verificationRecordSchema, type RecordStatus } from "../verification/openai/record";
import { makePng, syntheticRawVerification } from "../verification/openai/test-fixtures";

/**
 * TEST-ONLY orchestration inputs built in a temporary folder: a live-shaped
 * case with [TEST] listings and real PNG bytes, a saved shortlist, and Sol
 * records made through the real mapper from hand-written raw outputs. No
 * value here is a real model result.
 */

export const REF_PNG = makePng(48, 36, 7);
export const IMAGE_FILES = ["a.png", "b-gallery.png", "b-primary.png"];
export const imageBytes = (name: string) => makePng(32, 24, name.length * 11);
export const LISTING_A = "alibaba-product-0000000001";
export const LISTING_B = "alibaba-product-0000000002";
export const LISTING_C = "alibaba-product-0000000003";
export const LISTING_D = "alibaba-product-0000000004";
export const COMMIT = "f".repeat(40);
export const MODEL = "google/siglip2-base-patch16-384";

/** The shortlisting test manifest, with a recorded INR price and price tiers on listing A. */
export function orchestrationManifest() {
  const m = testManifest();
  m.candidates[0] = {
    ...m.candidates[0],
    price: { min: 1200.5, max: 1500, currency: "INR", unit: "piece" },
    minimumOrder: { quantity: 2, unit: "piece" },
    priceTiers: [{ minQuantity: 2, maxQuantity: 49, price: 1500, currency: "INR" }],
  };
  return m;
}

export async function writeOrchestrationCase(dir: string) {
  return writeTestCase(dir, orchestrationManifest(), IMAGE_FILES, { reference: REF_PNG, file: imageBytes });
}

/** A shortlist compatible with the case as written (A and B embedded, C and D excluded). */
export function savedShortlist(overrides: Record<string, unknown> = {}) {
  const imported = importCuratedCandidates([candidateManifestSchema.parse(testManifest())]);
  const entry = (listingId: string, ref: string, rank: number, cosine: number) => ({
    rank,
    listingId,
    title: imported.listings.find((l) => l.id === listingId)!.title,
    image: { ref: `${TEST_CASE}/${ref}`, sha256: sha256(imageBytes(ref)) },
    embeddingCosineSimilarity: cosine,
    visualVerificationStatus: "not_assessed",
  });
  return {
    recordType: "visual_shortlist",
    schemaVersion: 1,
    caseId: TEST_CASE,
    createdAt: "2026-10-27T10:00:00.000Z",
    synthetic: false,
    model: { id: MODEL, revision: COMMIT },
    preprocessing: { imageProcessor: "Test" },
    reference: { referenceImageId: "ref-test-live", fingerprintId: "fp-test-live", sha256: sha256(REF_PNG) },
    imageSelectionPolicy: IMAGE_SELECTION_POLICY,
    shortlist: [entry(LISTING_B, "b-primary.png", 1, 0.91), entry(LISTING_A, "a.png", 2, 0.83)],
    belowTopK: [],
    excluded: [
      { listingId: LISTING_C, reason: "no_usable_image" },
      { listingId: LISTING_D, reason: "no_image" },
    ],
    ...overrides,
  };
}

export async function writeSavedShortlist(dir: string, value: unknown = savedShortlist()) {
  await mkdir(join(dir, "shortlists"), { recursive: true });
  await writeFile(join(dir, "shortlists", `${TEST_CASE}-siglip2-base-patch16-384.json`), JSON.stringify(value));
}

let n = 0;
/** One Sol record for a listing, schema-valid, written where verify:visual would write it. */
export async function writeSolRecord(
  dir: string,
  opts: { listingId: string; imageFile: string; status?: RecordStatus; raw?: RawVisualVerification; instructionsVersion?: string; candidateSha?: string; requestedAt?: string },
) {
  const status = opts.status ?? "succeeded";
  const raw = opts.raw ?? syntheticRawVerification();
  const requestedAt = opts.requestedAt ?? `2026-10-27T10:0${n % 10}:00.000Z`;
  const attemptId = (++n).toString(16).padStart(8, "0");
  const candidateSha = opts.candidateSha ?? sha256(imageBytes(opts.imageFile));
  const ok = status === "succeeded";
  const record = verificationRecordSchema.parse({
    recordType: "visual_verification_run",
    schemaVersion: 1,
    status,
    attemptId,
    caseId: TEST_CASE,
    dataSource: "live",
    referenceImageId: "ref-test-live",
    fingerprintId: "fp-test-live",
    listingId: opts.listingId,
    marketplaceProductId: null,
    referenceImage: { ref: "reference", uri: "ref-test-live", sha256: sha256(REF_PNG), mimeType: "image/png", width: 48, height: 36 },
    candidateImage: { ref: `${TEST_CASE}/${opts.imageFile}`, uri: `local-evidence:${TEST_CASE}/${opts.imageFile}`, sha256: candidateSha, mimeType: "image/png", width: 32, height: 24 },
    request: {
      model: "gpt-6.1-sol",
      instructionsVersion: opts.instructionsVersion ?? VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
      imageDetail: "high",
      reasoningEffort: "medium",
      maxOutputTokens: 6000,
      timeoutMs: 180000,
      store: false,
      tools: "none",
      automaticRetries: 0,
    },
    requestedAt,
    completedAt: status === "requested" ? null : requestedAt,
    response: status === "requested" ? null : { responseId: `resp_${attemptId}`, responseModel: "gpt-6.1-sol-2026-10-01", usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, reasoningTokens: 200 } },
    error: ok || status === "requested" ? null : { category: "incomplete", message: "Model response was incomplete (max_output_tokens)", requestId: null },
    rawVerification: ok ? raw : null,
    assessment: ok
      ? mapRawVerificationToAssessment(raw, {
          assessmentId: `va-${attemptId}`,
          referenceImageId: "ref-test-live",
          fingerprintId: "fp-test-live",
          listingId: opts.listingId,
          candidateImageUri: `local-evidence:${TEST_CASE}/${opts.imageFile}`,
          assessedAt: requestedAt,
          modelId: "gpt-6.1-sol-2026-10-01",
          instructionsVersion: opts.instructionsVersion ?? VISUAL_VERIFICATION_INSTRUCTIONS_VERSION,
          responseId: `resp_${attemptId}`,
        })
      : null,
  });
  const folder = join(dir, "verifications", TEST_CASE, opts.listingId);
  await mkdir(folder, { recursive: true });
  const file = join(folder, `gpt-6.1-sol__${record.request.instructionsVersion}__${requestedAt.replace(/[:.]/g, "-")}__${attemptId}.json`);
  await writeFile(file, JSON.stringify(record));
  return file;
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
