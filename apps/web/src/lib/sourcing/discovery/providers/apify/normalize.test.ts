import { describe, expect, it } from "vitest";
import { importCuratedCandidates } from "../../curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../../curated/manifest";
import { buildProviderManifest, normalizeRunRows, ProviderSchemaError } from "./normalize";
import { imageRows, keywordRows, product } from "./test-fixtures";

const run = (items: unknown[], mode: "image" | "keyword" = "image", providerRunId = "RunImage000000001") =>
  normalizeRunRows({ mode, providerRunId, capturedAt: "2026-10-27T10:01:00.000Z", items }, "live");

function build(normalized: ReturnType<typeof run>[]) {
  return buildProviderManifest({
    caseId: "test-live-bed",
    referenceImageId: "ref-test-live",
    fingerprintId: "fp-test-live",
    dataSource: "live",
    capturedAt: "2026-10-27T10:05:00.000Z",
    runs: normalized.map((n) => ({ mode: n.mode, providerRunId: n.providerRunId, status: "succeeded", startedAt: null, finishedAt: null, chargedUsd: 0.004 })),
    normalized,
    queries: ["dark brown panel bed arched headboard"],
    notes: "[TEST] automated discovery",
  });
}

describe("provider row normalization", () => {
  it("keeps valid products and rejects bad rows with reasons", () => {
    const n = run(imageRows("live-shaped"));
    expect(n.rawCount).toBe(11);
    expect(n.candidates.map((c) => c.candidate.marketplaceProductId)).toEqual(["1000000000101", "1000000000102", "1000000000103", "1000000000104", "1000000000108"]);
    expect(n.rejections.map((r) => [r.index, r.reason])).toEqual([
      [4, "duplicate"],
      [5, "invalid_listing_url"],
      [6, "product_id_mismatch"],
      [7, "missing_title"],
      [10, "not_an_object"],
    ]);
    expect(n.providerErrors).toEqual([{ mode: "image", providerRunId: "RunImage000000001", index: 9, code: "BLOCKED", message: "Request was refused; this row is not a product" }]);
  });

  it("normalizes URLs, prices, tiers, MOQ and images without inventing values", () => {
    const [full, noPrice, noMoq, sameTitle, noImage] = run(imageRows("live-shaped")).candidates;
    expect(full.candidate).toMatchObject({
      listingUrl: "https://www.alibaba.com/product-detail/Arched-Panel-Bed_1000000000101.html",
      price: { min: 120, max: 180, currency: "USD", unit: "piece" },
      priceTiers: [
        { minQuantity: 2, maxQuantity: 49, price: 180, currency: null },
        { minQuantity: 50, maxQuantity: null, price: 120, currency: null },
      ],
      minimumOrder: { quantity: 2, unit: "piece" },
      capturedAt: "2026-10-27T10:00:00.000Z",
      foundWith: "provider_image_search",
      discoverySources: [{ mode: "image", providerRunId: "RunImage000000001", query: null, position: 1, sponsored: false }],
    });
    expect(full.candidate.images).toEqual([
      { url: "https://s.alicdn.com/kf/1000000000101-primary.jpg", role: "primary" },
      { url: "https://s.alicdn.com/kf/1000000000101-side.jpg", role: "gallery" },
    ]);
    expect(full.warnings).toContain("an image URL outside alibaba.com/alicdn.com was ignored");
    expect(noPrice.candidate.price).toBeUndefined();
    expect(noPrice.candidate.priceTiers).toBeUndefined();
    expect(noMoq.candidate.minimumOrder).toBeUndefined();
    expect(noMoq.supplier).toBeNull();
    expect(sameTitle.candidate.title).toBe(full.candidate.title); // same title, different product: both kept
    expect(noImage.candidate.images).toEqual([]);
    expect(noImage.warnings).toContain("no usable image URL");
    expect(noImage.candidate.discoverySources?.[0].sponsored).toBe(true);
  });

  it("records supplier badges only as positive external claims", () => {
    const [full, , , nameOnly] = run(imageRows("live-shaped")).candidates;
    expect(full.supplier).toEqual({
      name: "[TEST] Supplier 101 Furniture Co., Ltd.",
      profileUrl: "https://supplier101.en.alibaba.com",
      countryCode: "CN",
      platformTenureYears: 4,
      verifications: [{ type: "verified_supplier_badge", status: "verified", reportedBy: "alibaba.com (as reported by apify:scrapewise/alibaba-com-scraper)" }],
      tradeAssurance: { available: true },
      responsiveness: { responseRatePercent: 92 },
    });
    // verified: false means "badge not shown", never "not verified".
    expect(nameOnly.supplier).toEqual({ name: "[TEST] Name-only Trading Co." });
  });

  it("merges products found by both image and keyword search, keeping both sources", () => {
    const b = build([run(imageRows("live-shaped")), run(keywordRows("live-shaped"), "keyword", "RunKeyword0000001")]);
    expect(b.duplicatesMerged).toBe(1);
    const ids = b.manifest.candidates.map((c) => c.marketplaceProductId);
    expect(ids).toEqual(["1000000000101", "1000000000102", "1000000000103", "1000000000104", "1000000000108", "1000000000201"]);
    const merged = b.manifest.candidates[2];
    expect(merged.discoverySources?.map((d) => [d.mode, d.query])).toEqual([
      ["image", null],
      ["keyword", "dark brown panel bed arched headboard"],
    ]);
    expect(b.manifest.capture).toMatchObject({ method: "provider_api", tools: ["provider_image_search", "provider_keyword_search"], provider: { access: "third_party_service" } });
    expect(candidateManifestSchema.parse(b.manifest)).toEqual(b.manifest);
  });

  it("produces listings with provider_api provenance and intact supplier links", () => {
    const b = build([run(imageRows("live-shaped"))]);
    const imported = importCuratedCandidates([b.manifest]);
    expect(imported.acquisitionMethod).toBe("provider_api");
    const first = imported.listings[0];
    expect(first.provenance).toEqual({
      marketplace: "alibaba",
      dataSource: "live",
      retrievedAt: "2026-10-27T10:00:00.000Z",
      acquisitionMethod: "provider_api",
      providerSource: { providerId: "apify-alibaba-discovery", access: "third_party_service", runIds: ["RunImage000000001"] },
    });
    for (const l of imported.listings) {
      if (l.supplierId) expect(imported.suppliers.some((s) => s.id === l.supplierId)).toBe(true);
    }
    expect(imported.listings.find((l) => l.marketplaceProductId === "1000000000103")?.supplierId).toBeUndefined();
  });

  it("treats a changed output format as an error, not as an empty result", () => {
    expect(() => run([{ productId: "1", name: "x" }, { productId: "2" }])).toThrow(ProviderSchemaError);
    const broken = Array.from({ length: 6 }, (_, i) => ({ type: "product", title: 42, url: i }));
    expect(() => run(broken)).toThrow(/output format may have changed/);
    expect(run([]).candidates).toEqual([]);
  });

  it("rejects synthetic rows that point at real Alibaba.com and real rows on lookalike hosts", () => {
    const mock = normalizeRunRows({ mode: "image", providerRunId: "R1", capturedAt: "2026-10-27T10:01:00.000Z", items: imageRows("mock") }, "mock");
    expect(mock.rejections.find((r) => r.index === 5)).toMatchObject({ reason: "invalid_listing_url" });
    const lookalike = run([product("live-shaped", "1000000000301", { url: "https://alibaba.com.evil.example/product-detail/X_1000000000301.html" })]);
    expect(lookalike.rejections[0]).toMatchObject({ reason: "invalid_listing_url" });
  });
});
