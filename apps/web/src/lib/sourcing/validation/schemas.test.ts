import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MOCK_LISTINGS, MOCK_SUPPLIERS } from "../discovery/mock/fixtures";
import { MOCK_PROVIDER_INFO } from "../discovery/mock/mock-alibaba-adapter";
import type { DiscoverySearchResult } from "../discovery/types";
import type { RankedSourcingResult } from "../domain";
import { MOCK_FINGERPRINTS, MOCK_REFERENCE_IMAGES } from "../understanding/mock/fixtures";
import { MOCK_ASSESSMENTS } from "../verification/mock/fixtures";
import { visualMatchAssessmentSchema } from "./assessment";
import { isoTimestampSchema } from "./common";
import { discoverySearchResultSchema } from "./discovery";
import { furnitureFingerprintSchema } from "./fingerprint";
import { formatIssuePath, summarizeIssues } from "./issues";
import { candidateListingSchema } from "./listing";
import { referenceImageSchema } from "./reference-image";
import { rankedSourcingResultSchema } from "./result";
import { supplierProfileSchema } from "./supplier";

/* eslint-disable @typescript-eslint/no-explicit-any -- tests build malformed runtime data on purpose */
type Mutation = (value: any) => void;

/** Applies a mutation to a deep copy and returns "path: code" for each issue. */
function issuesAfter(schema: z.ZodType, base: unknown, mutate: Mutation): string[] {
  const value = structuredClone(base);
  mutate(value);
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((i) => `${formatIssuePath(i.path)}: ${i.code}`);
}

const chairFingerprint = MOCK_FINGERPRINTS[0];
const completeListing = MOCK_LISTINGS[0];
const completeSupplier = MOCK_SUPPLIERS[0];
const exactAssessment = MOCK_ASSESSMENTS[0];
const emptyDiscovery: DiscoverySearchResult = {
  listings: [],
  suppliers: [],
  provider: MOCK_PROVIDER_INFO,
  retrievedAt: "2026-10-24T10:00:00.000Z",
  queriesUsed: [],
};

describe("valid data", () => {
  it("accepts the synthetic reference images and fingerprints", () => {
    for (const reference of Object.values(MOCK_REFERENCE_IMAGES)) {
      expect(referenceImageSchema.safeParse(reference).success).toBe(true);
    }
    for (const fingerprint of MOCK_FINGERPRINTS) {
      expect(furnitureFingerprintSchema.parse(fingerprint)).toEqual(fingerprint);
    }
  });

  it("accepts observed, inferred and unknown features", () => {
    const certainties = chairFingerprint.appearance.map((f) => f.certainty);
    expect(certainties).toEqual(expect.arrayContaining(["observed", "inferred", "unknown"]));
    expect(furnitureFingerprintSchema.safeParse(chairFingerprint).success).toBe(true);
  });

  it("accepts complete and incomplete listings without adding defaults", () => {
    for (const listing of MOCK_LISTINGS) {
      expect(candidateListingSchema.parse(listing)).toEqual(listing);
    }
    const incomplete = candidateListingSchema.parse(MOCK_LISTINGS[5]);
    expect(incomplete).not.toHaveProperty("price");
    expect(incomplete).not.toHaveProperty("minimumOrder");
    expect(incomplete).not.toHaveProperty("supplierId");
  });

  it("keeps missing supplier verification missing, distinct from not_verified", () => {
    const sparse = supplierProfileSchema.parse(MOCK_SUPPLIERS[2]);
    expect(sparse).not.toHaveProperty("verifications");
    expect(sparse).not.toHaveProperty("tradeAssurance");

    const explicit = supplierProfileSchema.parse(MOCK_SUPPLIERS[1]);
    expect(explicit.verifications?.[0].status).toBe("not_verified");
    expect(explicit.tradeAssurance).toEqual({ available: false });
  });

  it("accepts an empty discovery result", () => {
    expect(discoverySearchResultSchema.safeParse(emptyDiscovery).success).toBe(true);
  });

  it("accepts every synthetic assessment, including null similarity", () => {
    for (const assessment of MOCK_ASSESSMENTS) {
      expect(visualMatchAssessmentSchema.parse(assessment)).toEqual(assessment);
    }
    expect(MOCK_ASSESSMENTS.some((a) => a.designSimilarityIndex === null)).toBe(true);
  });

  it("accepts the similarity bounds 0 and 100", () => {
    for (const designSimilarityIndex of [0, 100]) {
      expect(
        visualMatchAssessmentSchema.safeParse({ ...exactAssessment, designSimilarityIndex }).success,
      ).toBe(true);
    }
  });

  it("accepts ranked results with and without supplier or assessment", () => {
    const results: RankedSourcingResult[] = [
      { listing: completeListing, supplier: completeSupplier, assessment: exactAssessment, rank: 1 },
      { listing: MOCK_LISTINGS[5], rank: 2 },
      { listing: MOCK_LISTINGS[5] },
    ];
    for (const result of results) {
      expect(rankedSourcingResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it("accepts ISO 8601 timestamps with Z, offsets and fractional seconds", () => {
    for (const ts of ["2026-10-24T10:00:00Z", "2026-10-24T10:00:00.123Z", "2026-10-24T15:30:00+05:30", "2026-10-24T03:00:00-07:00"]) {
      expect(isoTimestampSchema.safeParse(ts).success).toBe(true);
    }
  });

  it("accepts non-URL image references such as storage keys", () => {
    expect(
      candidateListingSchema.safeParse({
        ...completeListing,
        images: [{ uri: "storage/listings/0001-front.jpg" }],
      }).success,
    ).toBe(true);
  });
});

describe("invalid data", () => {
  it.each<[string, Mutation, string]>([
    ["missing id", (v) => delete v.id, "id: invalid_type"],
    ["empty id", (v) => (v.id = ""), "id: too_small"],
    ["no reference image ids", (v) => (v.referenceImageIds = []), "referenceImageIds[0]: invalid_type"],
    ["category of wrong type", (v) => (v.category = 7), "category: invalid_type"],
    ["invalid certainty", (v) => (v.appearance[0].certainty = "maybe"), "appearance[0].certainty: invalid_union"],
    ["unknown feature with a value", (v) => (v.appearance[3].value = "oak"), "appearance[3]: unrecognized_keys"],
    ["observed feature without a value", (v) => delete v.structure[0].value, "structure[0].value: invalid_type"],
    ["invalid provenance data source", (v) => (v.source.dataSource = "synthetic"), "source.dataSource: invalid_value"],
    ["missing provenance data source", (v) => delete v.source.dataSource, "source.dataSource: invalid_value"],
    ["invalid timestamp", (v) => (v.createdAt = "yesterday"), "createdAt: invalid_format"],
    ["unknown top-level key", (v) => (v.rawModelOutput = "..."), "(root): unrecognized_keys"],
  ])("rejects a fingerprint with %s", (_name, mutate, expected) => {
    expect(issuesAfter(furnitureFingerprintSchema, chairFingerprint, mutate)).toContain(expected);
  });

  it.each<[string, Mutation, string]>([
    ["missing title", (v) => delete v.title, "title: invalid_type"],
    ["price as a string", (v) => (v.price.min = "28"), "price.min: invalid_type"],
    ["negative price", (v) => (v.price.min = -1), "price.min: too_small"],
    ["max below min", (v) => (v.price = { min: 30, max: 10 }), "price.max: custom"],
    ["lower-case currency", (v) => (v.price.currency = "usd"), "price.currency: invalid_format"],
    ["fractional MOQ", (v) => (v.minimumOrder.quantity = 1.5), "minimumOrder.quantity: invalid_type"],
    ["zero MOQ", (v) => (v.minimumOrder.quantity = 0), "minimumOrder.quantity: too_small"],
    ["non-http listing URL", (v) => (v.listingUrl = "javascript:alert(1)"), "listingUrl: invalid_format"],
    ["non-string attribute value", (v) => (v.attributes.width = 120), "attributes.width: invalid_type"],
    ["invalid provenance data source", (v) => (v.provenance.dataSource = "real"), "provenance.dataSource: invalid_value"],
    ["invalid retrieval timestamp", (v) => (v.provenance.retrievedAt = "2026-13-45"), "provenance.retrievedAt: invalid_format"],
  ])("rejects a listing with %s", (_name, mutate, expected) => {
    expect(issuesAfter(candidateListingSchema, completeListing, mutate)).toContain(expected);
  });

  it.each<[string, Mutation, string]>([
    ["verification status 'unknown'", (v) => (v.verifications[0].status = "unknown"), "verifications[0].status: invalid_value"],
    ["trade assurance as a string", (v) => (v.tradeAssurance.available = "yes"), "tradeAssurance.available: invalid_type"],
    ["country name instead of code", (v) => (v.countryCode = "China"), "countryCode: invalid_format"],
    ["response rate above 100", (v) => (v.responsiveness.responseRatePercent = 150), "responsiveness.responseRatePercent: too_big"],
  ])("rejects a supplier with %s", (_name, mutate, expected) => {
    expect(issuesAfter(supplierProfileSchema, completeSupplier, mutate)).toContain(expected);
  });

  it.each<[string, Mutation, string]>([
    ["listings not an array", (v) => (v.listings = {}), "listings: invalid_type"],
    ["missing provider", (v) => delete v.provider, "provider: invalid_type"],
    ["invalid provider data source", (v) => (v.provider.dataSource = "real"), "provider.dataSource: invalid_value"],
    ["missing retrieval timestamp", (v) => delete v.retrievedAt, "retrievedAt: invalid_type"],
    ["an invalid nested listing", (v) => v.listings.push({ id: "x" }), "listings[0].title: invalid_type"],
  ])("rejects a discovery result with %s", (_name, mutate, expected) => {
    expect(issuesAfter(discoverySearchResultSchema, emptyDiscovery, mutate)).toContain(expected);
  });

  it.each<[string, unknown, string]>([
    ["below 0", -1, "too_small"],
    ["above 100", 145, "too_big"],
    ["NaN", Number.NaN, "invalid_type"],
    ["Infinity", Number.POSITIVE_INFINITY, "invalid_type"],
    ["a numeric string", "90", "invalid_type"],
  ])("rejects similarity %s", (_name, designSimilarityIndex, code) => {
    expect(
      issuesAfter(visualMatchAssessmentSchema, exactAssessment, (v) => (v.designSimilarityIndex = designSimilarityIndex)),
    ).toContain(`designSimilarityIndex: ${code}`);
  });

  it.each<[string, Mutation, string]>([
    ["invalid classification", (v) => (v.classification = "exact"), "classification: invalid_value"],
    ["invalid confidence", (v) => (v.confidence = "very_high"), "confidence: invalid_value"],
    ["numeric confidence", (v) => (v.confidence = 0.9), "confidence: invalid_value"],
    ["missing metadata", (v) => delete v.metadata, "metadata: invalid_type"],
    ["invalid provenance data source", (v) => (v.metadata.dataSource = "synthetic"), "metadata.dataSource: invalid_value"],
    ["empty listing id", (v) => (v.listingId = ""), "listingId: too_small"],
  ])("rejects an assessment with %s", (_name, mutate, expected) => {
    expect(issuesAfter(visualMatchAssessmentSchema, exactAssessment, mutate)).toContain(expected);
  });

  it.each<[string, Mutation, string]>([
    ["rank 0", (v) => (v.rank = 0), "rank: too_small"],
    ["fractional rank", (v) => (v.rank = 1.5), "rank: invalid_type"],
    ["an invalid nested assessment", (v) => (v.assessment.confidence = "certain"), "assessment.confidence: invalid_value"],
  ])("rejects a ranked result with %s", (_name, mutate, expected) => {
    const base: RankedSourcingResult = { listing: completeListing, assessment: exactAssessment, rank: 1 };
    expect(issuesAfter(rankedSourcingResultSchema, base, mutate)).toContain(expected);
  });
});

describe("unknown keys and extensibility", () => {
  it("rejects unknown keys in fixed structures instead of stripping them", () => {
    const result = visualMatchAssessmentSchema.safeParse({
      ...exactAssessment,
      metadata: { ...exactAssessment.metadata, temperature: 0.2 },
    });
    expect(result.success).toBe(false);
  });

  it("keeps every key of the open-ended listing attributes", () => {
    const listing = {
      ...completeListing,
      attributes: { frame_material: "steel", provider_specific_code: "X-17" },
    };
    expect(candidateListingSchema.parse(listing).attributes).toEqual(listing.attributes);
  });
});

describe("issue summaries", () => {
  it("lists field paths and codes without echoing the payload", () => {
    const secret = "https://private.example.com/uploads/secret-token-123.jpg";
    const result = candidateListingSchema.safeParse({
      ...completeListing,
      images: [{ uri: secret, widthPx: "wide" }],
      price: { min: "secret-price-value" },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const summary = summarizeIssues(result.error);
    expect(summary).toContain("images[0].widthPx: invalid_type");
    expect(summary).toContain("price.min: invalid_type");
    expect(summary).not.toContain("secret");
    expect(JSON.stringify(result.error.issues)).not.toContain("secret");
  });

  it("truncates long issue lists", () => {
    const result = discoverySearchResultSchema.safeParse({
      ...emptyDiscovery,
      listings: Array.from({ length: 8 }, () => ({})),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(summarizeIssues(result.error)).toMatch(/; \+\d+ more$/);
  });
});
