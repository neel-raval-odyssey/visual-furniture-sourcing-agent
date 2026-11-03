import { describe, expect, it } from "vitest";
import { buildExaManifest, looksLikeFurniture, normalizeExaRows, readPriceAndMoq } from "./normalize";
import { exaResult, testListingUrl } from "./test-fixtures";

const rows = (items: unknown[], query = "pebble nesting coffee table", providerRunId = "req_1") => ({ providerRunId, query, capturedAt: "2026-11-03T10:00:00.000Z", items });
const reasons = (items: unknown[]) => normalizeExaRows(rows(items), "live").rejections.map((r) => r.reason);

describe("Alibaba.com result validation", () => {
  it("keeps a genuine-shaped product-detail page with its id, title, preview image and provenance", () => {
    const { candidates, rejections } = normalizeExaRows(rows([exaResult(1)]), "live");
    expect(rejections).toEqual([]);
    const c = candidates[0].candidate;
    expect(c.listingUrl).toBe(testListingUrl(1)); // query string removed
    expect(c.marketplaceProductId).toBe("1000000000001");
    expect(c.title).toBe("[TEST] Pebble nesting coffee table set 1");
    expect(c.images).toEqual([{ url: "https://s.alicdn.com/@sc04/kf/TEST-1.jpg", role: "primary", alt: null, mimeType: null }]);
    expect(c.discoverySources).toEqual([{ mode: "keyword", providerRunId: "req_1", query: "pebble nesting coffee table", position: 1, sponsored: null }]);
    expect(c.foundWith).toBe("provider_keyword_search");
    expect(c.notes).toMatch(/external search index/);
    expect(c.notes).toMatch(/Supplier not reported/);
  });

  it("rejects other sites, lookalike domains, other Alibaba Group marketplaces, http, credentials and ports", () => {
    expect(
      reasons([
        exaResult(1, { url: "https://www.example.com/product-detail/x_1000000000001.html" }),
        exaResult(2, { url: "https://www.alibaba.com.evil.example/product-detail/x_1000000000002.html" }),
        exaResult(3, { url: "https://my-alibaba.com/product-detail/x_1000000000003.html" }),
        exaResult(4, { url: "https://detail.1688.com/offer/1000000000004.html" }),
        exaResult(5, { url: "https://www.aliexpress.com/item/1000000000005.html" }),
        exaResult(6, { url: "http://www.alibaba.com/product-detail/x_1000000000006.html" }),
        exaResult(7, { url: "https://user:pw@www.alibaba.com/product-detail/x_1000000000007.html" }),
        exaResult(8, { url: "not a url" }),
      ]),
    ).toEqual(["not_alibaba", "not_alibaba", "not_alibaba", "not_alibaba", "not_alibaba", "invalid_url", "invalid_url", "invalid_url"]);
  });

  it("rejects Alibaba.com pages that are not product-detail pages (search results, showrooms, supplier sites)", () => {
    expect(
      reasons([
        exaResult(1, { url: "https://www.alibaba.com/trade/search?SearchText=nesting+table" }),
        exaResult(2, { url: "https://www.alibaba.com/showroom/nesting-coffee-table.html" }),
        exaResult(3, { url: "https://testsupplier.en.alibaba.com/product/1000000000003-1.html" }),
        exaResult(4, { url: "https://www.alibaba.com/product-detail/no-id-here.html" }),
      ]),
    ).toEqual(["not_product_page", "not_product_page", "not_product_page", "not_product_page"]);
  });

  it("rejects rows without a url or title, and titles that are not furniture", () => {
    expect(reasons([null, { title: "x" }, exaResult(3, { title: "  " }), exaResult(4, { title: "[TEST] Stainless steel kitchen knife set" })])).toEqual([
      "not_an_object",
      "not_an_object",
      "missing_title",
      "not_furniture",
    ]);
    expect(looksLikeFurniture("Modern nesting coffee tables")).toBe(true);
    expect(looksLikeFurniture("Bluetooth speaker")).toBe(false);
  });

  it("drops a duplicate product id within one query", () => {
    const { candidates, rejections } = normalizeExaRows(rows([exaResult(1), exaResult(1, { url: testListingUrl(1).replace("TEST-Pebble", "Other-Slug") })]), "live");
    expect(candidates).toHaveLength(1);
    expect(rejections.map((r) => r.reason)).toEqual(["duplicate"]);
  });

  it("ignores a preview image that is not on Alibaba.com's image hosts (never fetched)", () => {
    const { candidates } = normalizeExaRows(rows([exaResult(1, { image: "https://169.254.169.254/latest/meta-data.jpg" }), exaResult(2, { image: "https://images.example.com/a.jpg" }), exaResult(3, { image: null })]), "live");
    expect(candidates.map((c) => c.candidate.images)).toEqual([[], [], []]);
    expect(candidates[0].warnings[0]).toMatch(/preview image ignored/);
    expect(candidates[2].candidate.notes).toMatch(/No product image was reported/);
  });
});

describe("price, minimum order and supplier", () => {
  it("reads an explicit US$ range and a minimum order as written; a bare $ leaves the currency unknown", () => {
    expect(readPriceAndMoq(["US$45.00-52.00 / piece. Min. order: 2 pieces"])).toEqual({ price: { min: 45, max: 52, currency: "USD" }, minimumOrder: { quantity: 2, unit: "pieces" }, quoted: "US$45.00-52.00" });
    expect(readPriceAndMoq(["$1,200 Minimum order quantity 50 sets"])).toEqual({ price: { min: 1200 }, minimumOrder: { quantity: 50, unit: "sets" }, quoted: "$1,200" });
    expect(readPriceAndMoq(["No price shown"])).toEqual({ price: null, minimumOrder: null, quoted: null });
  });

  it("keeps missing price and MOQ missing, and never derives a supplier", () => {
    const { candidates } = normalizeExaRows(rows([exaResult(1, { highlights: null, title: "[TEST] Shenzhen Example Furniture Co. coffee table" })]), "live");
    const c = candidates[0].candidate;
    expect(c.price).toBeUndefined();
    expect(c.minimumOrder).toBeUndefined();
    expect(c.supplierRef).toBeUndefined();
    expect(c.notes).toMatch(/Price and minimum order not reported/);
  });

  it("labels an excerpt price as possibly stale", () => {
    expect(normalizeExaRows(rows([exaResult(1)]), "live").candidates[0].candidate.notes).toMatch(/may be stale/);
  });
});

describe("manifest across queries", () => {
  const build = (r: ReturnType<typeof rows>[], max?: number) =>
    buildExaManifest({
      caseId: "upl-test-case",
      referenceImageId: "ref-test",
      fingerprintId: "fp-test",
      dataSource: "live",
      capturedAt: "2026-11-03T10:00:00.000Z",
      runs: r.map((x) => ({ providerRunId: x.providerRunId, status: "succeeded", startedAt: null, finishedAt: null, chargedUsd: 0.017 })),
      rows: r,
      queries: r.map((x) => x.query),
      maxUniqueLeads: max,
      notes: "[TEST]",
    });

  it("merges the same product found by two queries, keeping both sources, with an external-search-index provider and no suppliers", () => {
    const out = build([rows([exaResult(1), exaResult(2)], "q one", "req_1"), rows([exaResult(2), exaResult(3)], "q two", "req_2")]);
    expect(out.manifest.candidates.map((c) => c.marketplaceProductId)).toEqual(["1000000000001", "1000000000002", "1000000000003"]);
    expect(out.duplicatesMerged).toBe(1);
    expect(out.manifest.candidates[1].discoverySources?.map((d) => d.query)).toEqual(["q one", "q two"]);
    expect(out.manifest.capture.method).toBe("provider_api");
    expect(out.manifest.capture.provider?.access).toBe("external_search_index");
    expect(out.manifest.capture.provider?.service).toBe("exa");
    expect(out.manifest.suppliers).toEqual([]);
    expect(out.rawCount).toBe(4);
  });

  it("keeps at most the unique-lead limit and records the rest", () => {
    const out = build([rows([1, 2, 3, 4].map((n) => exaResult(n)))], 2);
    expect(out.manifest.candidates).toHaveLength(2);
    expect(out.rejections.map((r) => r.reason)).toEqual(["over_limit", "over_limit"]);
  });

  it("an empty result is a valid, empty candidate set (not an error)", () => {
    const out = build([rows([])]);
    expect(out.manifest.candidates).toEqual([]);
    expect(out.manifest.capture.status).toBe("completed");
  });
});
