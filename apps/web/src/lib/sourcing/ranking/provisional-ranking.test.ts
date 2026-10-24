import { describe, expect, it } from "vitest";
import type {
  CandidateListing,
  MatchClassification,
  SupplierProfile,
  VisualMatchAssessment,
} from "../domain";
import { ProvisionalRankingService } from "./provisional-ranking";

const provenance = {
  marketplace: "alibaba",
  dataSource: "mock",
  retrievedAt: "2026-01-01T00:00:00.000Z",
} as const;

function listing(id: string, supplierId?: string): CandidateListing {
  return {
    id,
    title: `Synthetic ${id}`,
    listingUrl: `https://example.com/${id}`,
    images: [],
    ...(supplierId ? { supplierId } : {}),
    provenance,
  };
}

function supplier(id: string): SupplierProfile {
  return { id, name: `Synthetic ${id}`, provenance };
}

function assessment(
  listingId: string,
  classification: MatchClassification,
  designSimilarityIndex: number | null,
): VisualMatchAssessment {
  return {
    id: `a-${listingId}`,
    referenceImageId: "ref",
    listingId,
    classification,
    designSimilarityIndex,
    confidence: "medium",
    supportingEvidence: [],
    differences: [],
    unverifiableFeatures: [],
    assessedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ranking = new ProvisionalRankingService();
const ids = (results: { listing: CandidateListing }[]) => results.map((r) => r.listing.id);

describe("ProvisionalRankingService", () => {
  it("orders by classification according to the provisional policy", async () => {
    const results = await ranking.rank({
      listings: ["none", "non", "insuf", "sim", "close", "exact"].map((id) => listing(id)),
      suppliers: [],
      assessments: [
        assessment("non", "non_match", 99),
        assessment("insuf", "insufficient_evidence", null),
        assessment("sim", "similar_alternative", 40),
        assessment("close", "close_variant", 10),
        assessment("exact", "exact_visual_design", 5),
      ],
    });

    expect(ids(results)).toEqual(["exact", "close", "sim", "insuf", "non", "none"]);
  });

  it("uses similarity as the secondary criterion, with null after numbers", async () => {
    const results = await ranking.rank({
      listings: ["a", "b", "c"].map((id) => listing(id)),
      suppliers: [],
      assessments: [
        assessment("a", "close_variant", null),
        assessment("b", "close_variant", 60),
        assessment("c", "close_variant", 85),
      ],
    });

    expect(ids(results)).toEqual(["c", "b", "a"]);
    expect(results[2].assessment?.designSimilarityIndex).toBeNull();
  });

  it("breaks ties by listing id regardless of input order", async () => {
    const assessments = [
      assessment("b", "similar_alternative", 50),
      assessment("a", "similar_alternative", 50),
    ];
    const forward = await ranking.rank({
      listings: [listing("a"), listing("b"), listing("d"), listing("c")],
      suppliers: [],
      assessments,
    });
    const reversed = await ranking.rank({
      listings: [listing("c"), listing("d"), listing("b"), listing("a")],
      suppliers: [],
      assessments: [...assessments].reverse(),
    });

    expect(ids(forward)).toEqual(["a", "b", "c", "d"]);
    expect(reversed).toEqual(forward);
  });

  it("assigns consecutive 1-based ranks", async () => {
    const results = await ranking.rank({
      listings: ["x", "y", "z"].map((id) => listing(id)),
      suppliers: [],
      assessments: [],
    });
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("handles missing assessments and missing suppliers", async () => {
    const results = await ranking.rank({
      listings: [listing("with-supplier", "s1"), listing("unknown-supplier", "s404"), listing("no-supplier")],
      suppliers: [supplier("s1")],
      assessments: [],
    });

    const byId = Object.fromEntries(results.map((r) => [r.listing.id, r]));
    expect(byId["with-supplier"].supplier?.id).toBe("s1");
    expect(byId["unknown-supplier"]).not.toHaveProperty("supplier");
    expect(byId["no-supplier"]).not.toHaveProperty("supplier");
    for (const r of results) expect(r).not.toHaveProperty("assessment");
  });

  it("associates suppliers and assessments with the right listings", async () => {
    const results = await ranking.rank({
      listings: [listing("l1", "s1"), listing("l2", "s2")],
      suppliers: [supplier("s2"), supplier("s1")],
      assessments: [assessment("l2", "exact_visual_design", 90), assessment("l1", "non_match", 10)],
    });

    for (const r of results) {
      expect(r.supplier?.id).toBe(r.listing.supplierId);
      expect(r.assessment?.listingId).toBe(r.listing.id);
    }
  });

  it("rejects multiple assessments for one listing", async () => {
    await expect(
      ranking.rank({
        listings: [listing("l1")],
        suppliers: [],
        assessments: [assessment("l1", "close_variant", 80), assessment("l1", "non_match", 5)],
      }),
    ).rejects.toThrow(/Multiple assessments/);
  });

  it("does not mutate its inputs or return aliases of them", async () => {
    const request = {
      listings: [listing("b", "s1"), listing("a")],
      suppliers: [supplier("s1")],
      assessments: [assessment("a", "close_variant", 70)],
    };
    const before = structuredClone(request);

    const results = await ranking.rank(request);
    results[0].listing.title = "changed";

    expect(request).toEqual(before);
  });
});
