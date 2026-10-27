/* eslint-disable @typescript-eslint/no-explicit-any -- fake SDK responses */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCuratedCandidates } from "../../discovery/curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../../discovery/curated/manifest";
import { createVerifiedCuratedSourcingPipeline } from "../../pipeline/verified";
import { summarizeSourcingRun } from "../../pipeline/summary";
import { EvidenceError, planListingImages, resolveReferenceImage } from "../../shortlisting/evidence";
import { TEST_CASE, testManifest, writeTestCase } from "../../shortlisting/test-fixtures";
import { loadSavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import type { ResponsesParseFn } from "../../understanding/openai/vision-client";
import { LocalVerificationEvidence } from "./evidence";
import { OpenAIVisualVerificationService, PaidRequestBudget, type PairOutcome } from "./openai-visual-verification";
import { fakeApiResponse, makePng, syntheticRawVerification } from "./test-fixtures";
import { OpenAIVisualVerificationClient } from "./verification-client";

const LISTING_A = "alibaba-product-0000000001";
const LISTING_B = "alibaba-product-0000000002";

let dir: string;
const fetchSpy = vi.fn();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-verify-"));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** A manifest with seller claims, prices and suppliers that must never reach the model. */
function manifestWithClaims() {
  const m = testManifest();
  m.candidates[0] = {
    ...m.candidates[0],
    title: "[TEST] Luxury Solid Oak Bed SECRET-TITLE",
    price: { min: 12345.67, max: 23456.78, currency: "INR", unit: "piece" },
    minimumOrder: { quantity: 77 },
    attributes: { "wood type": "SECRET-ATTRIBUTE-oak" },
    notes: "SECRET-NOTE strong visual-match candidate",
  };
  m.suppliers[0] = { ...m.suppliers[0], name: "[TEST] SECRET-SUPPLIER Co." };
  return m;
}

async function setup(manifest = manifestWithClaims()) {
  const paths = await writeTestCase(dir, manifest, undefined, {
    reference: makePng(40, 30, 1),
    file: (name) => makePng(32, 24, name.length + 2),
  });
  const saved = await loadSavedFingerprint(paths.record, TEST_CASE);
  const imported = importCuratedCandidates([candidateManifestSchema.parse(manifest)]);
  const reference = await resolveReferenceImage(paths.images, saved);
  const plans = await planListingImages(imported.listings, join(dir, "candidates"), TEST_CASE);
  return { paths, saved, imported, evidence: new LocalVerificationEvidence(reference, plans) };
}

function sdk(impl: () => Promise<unknown>) {
  const parse = vi.fn<(body: any, options?: any) => Promise<unknown>>(() => impl());
  return { parse, client: new OpenAIVisualVerificationClient({ parse: parse as unknown as ResponsesParseFn }) };
}

describe("OpenAIVisualVerificationService", () => {
  it("assesses each pair with trusted provenance and leaves image-less listings unassessed", async () => {
    const { saved, imported, evidence } = await setup();
    const { parse, client } = sdk(async () => fakeApiResponse(syntheticRawVerification()));
    const outcomes: PairOutcome[] = [];
    const service = new OpenAIVisualVerificationService({
      client,
      evidence,
      budget: new PaidRequestBudget(4),
      now: () => new Date("2026-10-26T12:00:00.000Z"),
      generateId: () => "va-fixed",
      onOutcome: async (o) => void outcomes.push(o),
    });
    const assessments = await service.verify({ reference: saved.reference, fingerprint: saved.fingerprint, listings: imported.listings });

    expect(parse).toHaveBeenCalledTimes(2); // listings C (remote only) and D (no images) are never sent
    expect(outcomes.map((o) => [o.listing.id, o.status])).toEqual([
      [LISTING_A, "succeeded"],
      [LISTING_B, "succeeded"],
      ["alibaba-product-0000000003", "no_usable_image"],
      ["alibaba-product-0000000004", "no_usable_image"],
    ]);
    expect(assessments).toHaveLength(2);
    expect(assessments[0]).toMatchObject({
      referenceImageId: "ref-test-live",
      fingerprintId: "fp-test-live",
      listingId: LISTING_A,
      designSimilarityIndex: 78,
      metadata: { dataSource: "live", method: "multimodal_model", modelId: "gpt-6.1-sol-2026-10-01" },
    });
    const first = outcomes[0] as Extract<PairOutcome, { status: "succeeded" }>;
    expect(first.candidate).toMatchObject({ ref: `${TEST_CASE}/a.png`, uri: `local-evidence:${TEST_CASE}/a.png`, mimeType: "image/png", width: 32, height: 24 });
    expect(first.response.responseId).toBe("resp_test_123");
  });

  it("sends only the two images and reference observations: no titles, suppliers, prices, claims or scores", async () => {
    const { saved, imported, evidence } = await setup();
    const { parse, client } = sdk(async () => fakeApiResponse(syntheticRawVerification()));
    await new OpenAIVisualVerificationService({ client, evidence, budget: new PaidRequestBudget(1) }).verify({
      reference: saved.reference,
      fingerprint: saved.fingerprint,
      listings: imported.listings.slice(0, 1),
    });
    const body = parse.mock.calls[0][0] as any;
    const text = JSON.stringify({ ...body, input: body.input.map((m: any) => ({ ...m, content: m.content.filter((c: any) => c.type === "input_text") })) });
    for (const forbidden of [
      "SECRET",
      "12345.67",
      "INR",
      "0000000001",
      "alibaba.com",
      "Supplier",
      "cosine",
      "SigLIP",
      "0.8968",
      "embeddingCosineSimilarity",
      "strong visual-match",
      "search",
      saved.fingerprint.searchQueries[0],
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("REFERENCE image:");
    expect(text).toContain("may be wrong");
    const images = body.input[0].content.filter((c: any) => c.type === "input_image");
    expect(images).toHaveLength(2);
  });

  it("enforces the request budget and stops after access errors without switching model", async () => {
    const { saved, imported, evidence } = await setup();
    const capped = sdk(async () => fakeApiResponse(syntheticRawVerification()));
    const outcomes: PairOutcome[] = [];
    await new OpenAIVisualVerificationService({ client: capped.client, evidence, budget: new PaidRequestBudget(1), onOutcome: async (o) => void outcomes.push(o) }).verify({
      reference: saved.reference,
      fingerprint: saved.fingerprint,
      listings: imported.listings,
    });
    expect(capped.parse).toHaveBeenCalledTimes(1);
    expect(outcomes[1]).toMatchObject({ listing: { id: LISTING_B }, status: "not_requested", reason: "budget_exhausted" });

    const denied = sdk(async () => {
      throw new OpenAI.NotFoundError(404, { message: "no model" }, "no model", new Headers());
    });
    const after: PairOutcome[] = [];
    const result = await new OpenAIVisualVerificationService({ client: denied.client, evidence, budget: new PaidRequestBudget(4), onOutcome: async (o) => void after.push(o) }).verify({
      reference: saved.reference,
      fingerprint: saved.fingerprint,
      listings: imported.listings,
    });
    expect(result).toEqual([]);
    expect(denied.parse).toHaveBeenCalledTimes(1);
    expect(denied.parse.mock.calls[0][0]).toMatchObject({ model: "gpt-6.1-sol" });
    expect(after.map((o) => o.status)).toEqual(["failed", "not_requested", "not_requested", "not_requested"]);
    expect(after[0]).toMatchObject({ status: "failed", category: "model_not_found" });
    expect(after[1]).toMatchObject({ status: "not_requested", reason: "stopped_after_fatal_error" });
  });

  it("keeps schema-valid but inconsistent output as invalid_output, never as an assessment", async () => {
    const { saved, imported, evidence } = await setup();
    const { client } = sdk(async () => fakeApiResponse(syntheticRawVerification({ classification: "non_match", design_similarity_index: 90 })));
    const outcomes: PairOutcome[] = [];
    const result = await new OpenAIVisualVerificationService({ client, evidence, budget: new PaidRequestBudget(1), onOutcome: async (o) => void outcomes.push(o) }).verify({
      reference: saved.reference,
      fingerprint: saved.fingerprint,
      listings: imported.listings.slice(0, 1),
    });
    expect(result).toEqual([]);
    expect(outcomes[0]).toMatchObject({ status: "invalid_output", category: "malformed_output", raw: { design_similarity_index: 90 }, response: { responseId: "resp_test_123" } });
  });

  it("refuses evidence that changed after validation, before any request", async () => {
    const { saved, imported, evidence } = await setup();
    await writeFile(join(dir, "candidates", TEST_CASE, "a.png"), makePng(32, 24, 99));
    const { parse, client } = sdk(async () => fakeApiResponse(syntheticRawVerification()));
    await expect(
      new OpenAIVisualVerificationService({ client, evidence, budget: new PaidRequestBudget(1) }).verify({
        reference: saved.reference,
        fingerprint: saved.fingerprint,
        listings: imported.listings.slice(0, 1),
      }),
    ).rejects.toBeInstanceOf(EvidenceError);
    expect(parse).not.toHaveBeenCalled();
  });

  it("falls back to the next decodable image and records why", async () => {
    const { saved, imported } = await setup();
    // Corrupt listing B's primary image, then plan: the gallery image must be chosen instead.
    await writeFile(join(dir, "candidates", TEST_CASE, "b-primary.png"), makePng(32, 24, 5).subarray(0, 60));
    const plans = await planListingImages(imported.listings, join(dir, "candidates"), TEST_CASE);
    const ref = await resolveReferenceImage(join(dir, "images.json"), saved);
    const fresh = new LocalVerificationEvidence(ref, plans);
    const chosen = await fresh.candidate(imported.listings[1]);
    expect(chosen).toMatchObject({ ref: `${TEST_CASE}/b-gallery.png` });
  });

  it("integrates with SourcingPipeline through the verified composition root", async () => {
    const manifest = manifestWithClaims();
    const { saved, evidence } = await setup(manifest);
    const { client } = sdk(async () => fakeApiResponse(syntheticRawVerification()));
    const service = new OpenAIVisualVerificationService({ client, evidence, budget: new PaidRequestBudget(4) });
    const { pipeline } = createVerifiedCuratedSourcingPipeline({
      fingerprint: saved.fingerprint,
      manifests: [candidateManifestSchema.parse(manifest)],
      visualVerification: service,
    });
    const run = await pipeline.run({ reference: saved.reference });
    expect(run.assessments).toHaveLength(2);
    const summary = summarizeSourcingRun(run);
    expect(summary.dataSources.assessments).toEqual(["live"]);
    const unassessed = run.results.filter((r) => !r.assessment).map((r) => r.listing.id);
    expect(unassessed.sort()).toEqual(["alibaba-product-0000000003", "alibaba-product-0000000004"]);
  });
});
