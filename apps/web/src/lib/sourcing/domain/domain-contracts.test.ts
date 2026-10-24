import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CandidateListing,
  FurnitureFeature,
  FurnitureFingerprint,
  RankedSourcingResult,
  ReferenceImage,
  SupplierProfile,
  VisualMatchAssessment,
} from ".";

// Type-level assertions (satisfies, @ts-expect-error) are enforced by
// `pnpm typecheck`; runtime assertions check the shapes survive JSON.

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const pinterestReference = {
  id: "ref-001",
  image: { uri: "https://example.com/uploads/ref-001.jpg", mimeType: "image/jpeg" },
  origin: { kind: "social_media", platform: "Pinterest" },
  sourceUrl: "https://example.com/pin/123",
  submittedAt: "2026-10-24T09:00:00.000Z",
} satisfies ReferenceImage;

const fingerprint = {
  id: "fp-001",
  referenceImageIds: [pinterestReference.id],
  category: "chair",
  subtype: "dining_chair",
  structure: [
    { attribute: "leg_count", value: "4", certainty: "observed" },
    { attribute: "back_shape", value: "curved", certainty: "observed" },
  ],
  appearance: [
    { attribute: "frame_colour", value: "dark brown", certainty: "observed" },
    {
      attribute: "frame_material",
      value: "solid wood",
      certainty: "inferred",
      rationale: "Wood-like grain visible; could be veneer or print.",
    },
    {
      attribute: "wood_species",
      certainty: "unknown",
      rationale: "Not determinable from a photograph.",
    },
  ],
  distinctiveFeatures: [
    { attribute: "backrest", value: "steam-bent slats", certainty: "observed" },
  ],
  searchQueries: ["curved back dining chair"],
  source: { kind: "fixture" },
  createdAt: "2026-10-24T09:01:00.000Z",
} satisfies FurnitureFingerprint;

const sparseSupplier = {
  id: "supplier-sparse",
  name: "Synthetic Sparse Supplier",
  provenance: {
    marketplace: "alibaba",
    dataSource: "mock",
    retrievedAt: "2026-10-24T09:02:00.000Z",
  },
} satisfies SupplierProfile;

const incompleteListing = {
  id: "listing-incomplete",
  title: "Synthetic listing",
  listingUrl: "https://example.com/products/x",
  images: [],
  provenance: sparseSupplier.provenance,
} satisfies CandidateListing;

describe("ReferenceImage", () => {
  it("does not require a marketplace origin", () => {
    const personal: ReferenceImage = {
      id: "ref-002",
      image: { uri: "local/ref-002.jpg" },
      origin: { kind: "personal_photo" },
      submittedAt: "2026-10-24T09:00:00.000Z",
    };
    expect(personal.origin.kind).not.toBe("marketplace");
    expect(personal.sourceUrl).toBeUndefined();
    expect(roundTrip(pinterestReference)).toEqual(pinterestReference);
  });

  it("supports catalogue metadata", () => {
    const catalogue: ReferenceImage = {
      ...pinterestReference,
      origin: { kind: "catalogue" },
      catalogue: { title: "Synthetic Catalogue", pageNumber: 12, itemCode: "SC-12" },
    };
    expect(catalogue.catalogue?.pageNumber).toBe(12);
  });
});

describe("FurnitureFingerprint", () => {
  it("distinguishes observed, inferred and unknown features", () => {
    const certainties = fingerprint.appearance.map((f) => f.certainty);
    expect(certainties).toEqual(["observed", "inferred", "unknown"]);

    const unknown = fingerprint.appearance.find((f) => f.certainty === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown && "value" in unknown).toBe(false);
  });

  it("rejects a value on an unknown feature at the type level", () => {
    // @ts-expect-error unknown features cannot carry a value
    const invalid: FurnitureFeature = { attribute: "x", certainty: "unknown", value: "y" };
    expect(invalid.attribute).toBe("x");
  });

  it("requires at least one reference image id", () => {
    // @ts-expect-error referenceImageIds must be non-empty
    const ids: FurnitureFingerprint["referenceImageIds"] = [];
    expect(ids).toHaveLength(0);
    expect(roundTrip(fingerprint)).toEqual(fingerprint);
  });
});

describe("SupplierProfile", () => {
  it("allows every optional field to be absent", () => {
    expect(sparseSupplier).not.toHaveProperty("verifications");
    expect(sparseSupplier).not.toHaveProperty("tradeAssurance");
    expect(sparseSupplier).not.toHaveProperty("countryCode");
    expect(roundTrip(sparseSupplier)).toEqual(sparseSupplier);
  });
});

describe("CandidateListing", () => {
  it("allows price, MOQ, supplier and attributes to be absent", () => {
    expect(incompleteListing).not.toHaveProperty("price");
    expect(incompleteListing).not.toHaveProperty("minimumOrder");
    expect(incompleteListing).not.toHaveProperty("supplierId");
    expect(roundTrip(incompleteListing)).toEqual(incompleteListing);
  });
});

describe("VisualMatchAssessment", () => {
  it("keeps design similarity separate from assessment confidence", () => {
    expectTypeOf<VisualMatchAssessment["designSimilarityIndex"]>().toEqualTypeOf<number | null>();
    expectTypeOf<VisualMatchAssessment["confidence"]>().toEqualTypeOf<
      "low" | "medium" | "high"
    >();

    // Example values only: high similarity with low confidence is representable.
    const assessment: VisualMatchAssessment = {
      id: "assess-001",
      referenceImageId: pinterestReference.id,
      fingerprintId: fingerprint.id,
      listingId: incompleteListing.id,
      classification: "close_variant",
      designSimilarityIndex: 90,
      confidence: "low",
      supportingEvidence: [{ feature: "back_shape", description: "Both curved." }],
      differences: [],
      unverifiableFeatures: ["wood_species"],
      assessedAt: "2026-10-24T09:03:00.000Z",
    };
    expect(assessment.designSimilarityIndex).toBe(90);
    expect(assessment.confidence).toBe("low");
  });

  it("allows a null similarity for insufficient evidence", () => {
    const insufficient: Pick<VisualMatchAssessment, "classification" | "designSimilarityIndex"> = {
      classification: "insufficient_evidence",
      designSimilarityIndex: null,
    };
    expect(insufficient.designSimilarityIndex).toBeNull();
  });
});

describe("RankedSourcingResult", () => {
  it("represents a discovery-only result without assessment or rank", () => {
    const result: RankedSourcingResult = { listing: incompleteListing };
    expect(result.assessment).toBeUndefined();
    expect(result.rank).toBeUndefined();
    expect(result.supplier).toBeUndefined();
  });
});
