import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_LISTINGS } from "../../discovery/mock/fixtures";
import type { CandidateListing } from "../../domain";
import { MOCK_FINGERPRINTS, MOCK_REFERENCE_IMAGES } from "../../understanding/mock/fixtures";
import { MOCK_ASSESSMENTS } from "./fixtures";
import { MockVisualVerificationService } from "./mock-visual-verification";

const listing = (id: string): CandidateListing => {
  const found = MOCK_LISTINGS.find((l) => l.id === id);
  if (!found) throw new Error(`fixture ${id} missing`);
  return found;
};

const chairRequest = (listings: CandidateListing[]) => ({
  reference: MOCK_REFERENCE_IMAGES.chair,
  fingerprint: MOCK_FINGERPRINTS[0],
  listings,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MockVisualVerificationService", () => {
  const service = new MockVisualVerificationService();

  it("returns assessments for known candidates, linked to their listing ids", async () => {
    const listings = ["mock-listing-001", "mock-listing-002", "mock-listing-003"].map(listing);
    const assessments = await service.verify(chairRequest(listings));

    expect(assessments.map((a) => a.listingId)).toEqual(listings.map((l) => l.id));
    for (const a of assessments) {
      expect(a.referenceImageId).toBe(MOCK_REFERENCE_IMAGES.chair.id);
      expect(a.fingerprintId).toBe("mock-fp-chair-001");
    }
  });

  it("only assesses the candidates it is given", async () => {
    const assessments = await service.verify(chairRequest([listing("mock-listing-002")]));
    expect(assessments.map((a) => a.listingId)).toEqual(["mock-listing-002"]);
  });

  it("leaves candidates without a predefined assessment unassessed", async () => {
    // Listing 004 has an assessment only for the table reference.
    const assessments = await service.verify(chairRequest([listing("mock-listing-004")]));
    expect(assessments).toEqual([]);
  });

  it("covers every match classification across the fixtures", () => {
    expect(new Set(MOCK_ASSESSMENTS.map((a) => a.classification))).toEqual(
      new Set([
        "exact_visual_design",
        "close_variant",
        "similar_alternative",
        "non_match",
        "insufficient_evidence",
      ]),
    );
  });

  it("keeps similarity separate from confidence, with null similarity when evidence is insufficient", async () => {
    const [assessment] = await service.verify(chairRequest([listing("mock-listing-003")]));

    expect(assessment.classification).toBe("insufficient_evidence");
    expect(assessment.designSimilarityIndex).toBeNull();
    expect(assessment.confidence).toBe("low");

    // High similarity does not imply high confidence in the fixtures.
    const exact = MOCK_ASSESSMENTS.find((a) => a.classification === "exact_visual_design");
    expect(exact?.designSimilarityIndex).toBe(94);
    expect(exact?.confidence).toBe("medium");
  });

  it("marks every assessment as synthetic, not model-generated", () => {
    for (const a of MOCK_ASSESSMENTS) {
      expect(a.metadata?.method).toBe("fixture");
      expect(a.metadata?.modelId).toBeUndefined();
      expect(a.metadata?.notes).toMatch(/synthetic/i);
    }
  });

  it("performs no inference or network access and does not mutate inputs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const listings = [listing("mock-listing-001")];
    const before = structuredClone(listings);

    const [assessment] = await service.verify(chairRequest(listings));
    assessment.designSimilarityIndex = 0;

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listings).toEqual(before);
    expect(MOCK_ASSESSMENTS[0].designSimilarityIndex).toBe(94);
  });
});
