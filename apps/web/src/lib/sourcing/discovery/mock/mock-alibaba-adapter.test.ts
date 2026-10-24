import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  CandidateListing,
  FurnitureFingerprint,
  MatchClassification,
  ReferenceImage,
  SupplierProfile,
} from "../../domain";
import type {
  AlibabaDiscoveryAdapter,
  DiscoverySearchRequest,
  DiscoverySearchResult,
} from "../types";
import { MOCK_LISTINGS, MOCK_SUPPLIERS } from "./fixtures";
import { MockAlibabaDiscoveryAdapter } from "./mock-alibaba-adapter";

const FIXED_NOW = new Date("2026-10-24T10:00:00.000Z");

/**
 * Fields that belong to visual matching or ranking, never to discovery.
 * "classification" is deliberately absent: SupplierProfile.classification is a
 * business type (e.g. "manufacturer"). Match classifications are checked by
 * value instead.
 */
const MATCHING_STAGE_KEYS = [
  "assessment",
  "assessments",
  "designSimilarityIndex",
  "similarity",
  "score",
  "confidence",
  "rank",
  "ranking",
] as const;
type MatchingStageKey = (typeof MATCHING_STAGE_KEYS)[number];

const MATCH_CLASSIFICATIONS = [
  "exact_visual_design",
  "close_variant",
  "similar_alternative",
  "non_match",
  "insufficient_evidence",
] as const satisfies readonly MatchClassification[];

function collectKeysAndStrings(
  value: unknown,
  found = { keys: new Set<string>(), strings: new Set<string>() },
) {
  if (typeof value === "string") {
    found.strings.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectKeysAndStrings(item, found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.keys.add(key);
      collectKeysAndStrings(child, found);
    }
  }
  return found;
}

const reference: ReferenceImage = {
  id: "ref-001",
  image: { uri: "https://example.com/uploads/ref-001.jpg" },
  origin: { kind: "retail_website" },
  submittedAt: "2026-10-24T09:00:00.000Z",
};

const chairFingerprint: FurnitureFingerprint = {
  id: "fp-001",
  referenceImageIds: [reference.id],
  category: "chair",
  structure: [],
  appearance: [],
  distinctiveFeatures: [],
  searchQueries: ["dining chair"],
  source: { kind: "fixture" },
  createdAt: "2026-10-24T09:01:00.000Z",
};

function request(overrides: Partial<DiscoverySearchRequest> = {}): DiscoverySearchRequest {
  return { reference, mode: "text", limit: 10, ...overrides };
}

function createAdapter(): AlibabaDiscoveryAdapter {
  return new MockAlibabaDiscoveryAdapter({ now: () => FIXED_NOW });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MockAlibabaDiscoveryAdapter", () => {
  it("returns candidates for a supported request", async () => {
    const result = await createAdapter().discoverCandidates(
      request({ fingerprint: chairFingerprint }),
    );

    expect(result.listings.map((l) => l.id)).toEqual([
      "mock-listing-001",
      "mock-listing-002",
    ]);
    expect(result.queriesUsed).toEqual(["dining chair"]);
    expect(result.categoryUsed).toBe("chair");
    expect(result.retrievedAt).toBe(FIXED_NOW.toISOString());
  });

  it("filters by category for image-only requests", async () => {
    const result = await createAdapter().discoverCandidates(
      request({ mode: "image", category: "table", queries: ["ignored"] }),
    );

    expect(result.listings.map((l) => l.id)).toEqual([
      "mock-listing-004",
      "mock-listing-005",
    ]);
    expect(result.queriesUsed).toEqual([]);
  });

  it("returns an empty result for a query with no matches", async () => {
    const result = await createAdapter().discoverCandidates(
      request({ queries: ["velvet canopy bed"] }),
    );

    expect(result.listings).toEqual([]);
    expect(result.suppliers).toEqual([]);
    expect(result.provider.dataSource).toBe("mock");
  });

  it("respects the candidate limit", async () => {
    const adapter = createAdapter();
    const limited = await adapter.discoverCandidates(request({ limit: 2 }));
    const all = await adapter.discoverCandidates(request({ limit: 100 }));

    expect(limited.listings).toHaveLength(2);
    expect(all.listings).toHaveLength(MOCK_LISTINGS.length);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid limit %s", async (limit) => {
    await expect(createAdapter().discoverCandidates(request({ limit }))).rejects.toThrow(
      RangeError,
    );
  });

  it("returns deterministic results", async () => {
    const adapter = createAdapter();
    const input = request({ queries: ["metal"] });

    const first = await adapter.discoverCandidates(input);
    const second = await adapter.discoverCandidates(input);

    expect(second).toEqual(first);
    expect(first.listings.map((l) => l.id)).toEqual([
      "mock-listing-001",
      "mock-listing-005",
    ]);
  });

  it("returns exactly the suppliers referenced by the listings", async () => {
    const result = await createAdapter().discoverCandidates(request());
    const supplierIds = result.suppliers.map((s) => s.id);

    for (const listing of result.listings) {
      if (listing.supplierId) expect(supplierIds).toContain(listing.supplierId);
    }
    const referenced = new Set(result.listings.flatMap((l) => l.supplierId ?? []));
    expect(new Set(supplierIds)).toEqual(referenced);
    expect(supplierIds).toHaveLength(referenced.size);
  });

  it("returns incomplete listings and sparse suppliers without filling gaps", async () => {
    const result = await createAdapter().discoverCandidates(request());

    const incomplete = result.listings.find((l) => l.id === "mock-listing-006");
    expect(incomplete).toBeDefined();
    expect(incomplete).not.toHaveProperty("price");
    expect(incomplete).not.toHaveProperty("minimumOrder");
    expect(incomplete).not.toHaveProperty("supplierId");

    const sparse = result.suppliers.find((s) => s.id === "mock-supplier-003");
    expect(sparse).toBeDefined();
    expect(sparse).not.toHaveProperty("verifications");
    expect(sparse).not.toHaveProperty("tradeAssurance");
  });

  it("clearly identifies all returned data as mock", async () => {
    const result = await createAdapter().discoverCandidates(request());

    expect(result.provider).toEqual({
      providerId: "mock-alibaba",
      marketplace: "alibaba",
      dataSource: "mock",
    });
    for (const listing of result.listings) {
      expect(listing.provenance.dataSource).toBe("mock");
      expect(listing.title).toMatch(/^\[MOCK\]/);
      expect(new URL(listing.listingUrl).hostname).toBe("example.com");
    }
    for (const supplier of result.suppliers) {
      expect(supplier.provenance.dataSource).toBe("mock");
      expect(supplier.name).toMatch(/\(Mock\)$/);
    }
  });

  it("returns the required discovery fields", async () => {
    const result = await createAdapter().discoverCandidates(request());

    expect(Array.isArray(result.listings)).toBe(true);
    expect(Array.isArray(result.suppliers)).toBe(true);
    expect(Array.isArray(result.queriesUsed)).toBe(true);
    expect(result.provider).toMatchObject({ providerId: expect.any(String), dataSource: "mock" });
    expect(Date.parse(result.retrievedAt)).not.toBeNaN();
  });

  it("does not include similarity, confidence or ranking anywhere in the response", async () => {
    // Compile-time: the contracts have no matching-stage fields.
    expectTypeOf<Extract<keyof DiscoverySearchResult, MatchingStageKey>>().toBeNever();
    expectTypeOf<Extract<keyof CandidateListing, MatchingStageKey>>().toBeNever();
    expectTypeOf<Extract<keyof SupplierProfile, MatchingStageKey>>().toBeNever();

    // Runtime: no matching-stage keys at any depth of the returned data.
    const result = await createAdapter().discoverCandidates(
      request({ mode: "image_and_text", fingerprint: chairFingerprint }),
    );
    const found = collectKeysAndStrings(result);
    const keys = [...found.keys];
    const strings = [...found.strings];
    for (const key of MATCHING_STAGE_KEYS) {
      expect(keys).not.toContain(key);
    }
    for (const classification of MATCH_CLASSIFICATIONS) {
      expect(strings).not.toContain(classification);
    }
  });

  it("does not mutate its source fixtures", async () => {
    const before = structuredClone([MOCK_LISTINGS, MOCK_SUPPLIERS]);
    const adapter = createAdapter();

    const result = await adapter.discoverCandidates(request());
    result.listings[0].title = "changed";
    result.listings[0].images.push({ uri: "changed" });
    result.suppliers[0].name = "changed";

    expect([MOCK_LISTINGS, MOCK_SUPPLIERS]).toEqual(before);
    const again = await adapter.discoverCandidates(request());
    expect(again.listings[0].title).toBe(MOCK_LISTINGS[0].title);
  });

  it("makes no external requests", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access is not allowed in the mock adapter");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await createAdapter().discoverCandidates(
      request({ mode: "image_and_text", fingerprint: chairFingerprint }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
