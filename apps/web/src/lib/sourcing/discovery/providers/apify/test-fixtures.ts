import type { ApifyRun } from "./apify-client";

/**
 * TEST FIXTURES: fabricated provider rows and runs. Product ids, titles,
 * suppliers and URLs are invented. "mock" rows use reserved example domains;
 * "live-shaped" rows use alibaba.com-shaped URLs with [TEST] titles and exist
 * only in memory or temporary folders during tests.
 */

export type FixtureFlavour = "mock" | "live-shaped";

const hosts = (f: FixtureFlavour) =>
  f === "mock"
    ? { page: "https://www.alibaba.example", img: "https://img.alibaba.example", supplier: (n: string) => `https://${n}.alibaba.example` }
    : { page: "https://www.alibaba.com", img: "https://s.alicdn.com", supplier: (n: string) => `https://${n}.en.alibaba.com` };

const label = (f: FixtureFlavour) => (f === "mock" ? "[SYNTHETIC]" : "[TEST]");

export function product(f: FixtureFlavour, id: string, overrides: Record<string, unknown> = {}) {
  const h = hosts(f);
  return {
    type: "product",
    productId: id,
    title: `${label(f)} Arched panel bed ${id.slice(-3)}`,
    url: `${h.page}/product-detail/Arched-Panel-Bed_${id}.html?spm=tracking`,
    priceMin: 120,
    priceMax: 180,
    currency: "usd",
    priceTiers: [
      { minQuantity: 2, maxQuantity: 49, price: 180 },
      { minQuantity: 50, maxQuantity: null, price: 120 },
    ],
    minOrderQuantity: 2,
    unit: "piece",
    imageUrl: `//${h.img.replace("https://", "")}/kf/${id}-primary.jpg`,
    images: [`${h.img}/kf/${id}-primary.jpg`, `${h.img}/kf/${id}-side.jpg`, "https://images.other-host.example/x.jpg"],
    isAd: false,
    position: 1,
    searchedAs: "image",
    scrapedAt: "2026-10-27T10:00:00.000Z",
    supplier: {
      companyName: `${label(f)} Supplier ${id.slice(-3)} Furniture Co., Ltd.`,
      country: "CN",
      goldSupplierYears: 4,
      verified: true,
      tradeAssurance: true,
      responseRate: "92%",
      url: h.supplier(`supplier${id.slice(-3)}`),
    },
    ...overrides,
  };
}

/** Image-search rows covering valid, missing-field, duplicate, malformed and error cases. */
export function imageRows(f: FixtureFlavour) {
  const h = hosts(f);
  const other = f === "mock" ? "https://www.alibaba.com" : "https://www.alibaba.com.evil.example";
  return [
    product(f, "1000000000101"),
    product(f, "1000000000102", { priceMin: null, priceMax: null, currency: null, priceTiers: null, position: 2 }),
    product(f, "1000000000103", { minOrderQuantity: null, position: 3, supplier: null }),
    product(f, "1000000000104", { title: product(f, "1000000000101").title, position: 4, supplier: { companyName: `${label(f)} Name-only Trading Co.`, verified: false } }),
    product(f, "1000000000101", { position: 5 }), // duplicate id within the run
    product(f, "1000000000105", { url: `${other}/product-detail/Lookalike_1000000000105.html`, position: 6 }),
    product(f, "1000000000106", { url: `${h.page}/product-detail/Mismatch_1000000000999.html`, position: 7 }),
    product(f, "1000000000107", { title: "   ", position: 8 }),
    product(f, "1000000000108", { imageUrl: null, images: [], position: 9, isAd: true }),
    { type: "error", errorCode: "BLOCKED", error: "Request was refused; this row is not a product" },
    "not an object",
  ];
}

/** Keyword rows: one overlaps the image run, one is new. */
export function keywordRows(f: FixtureFlavour) {
  return [
    product(f, "1000000000103", { searchInput: "dark brown panel bed arched headboard", searchedAs: "keyword", position: 1 }),
    product(f, "1000000000201", { searchInput: "dark brown panel bed arched headboard", searchedAs: "keyword", position: 2 }),
  ];
}

export function fakeRun(overrides: Partial<ApifyRun> = {}): ApifyRun {
  return {
    id: "RunTest00000000001",
    status: "SUCCEEDED",
    statusMessage: null,
    startedAt: "2026-10-27T10:00:00.000Z",
    finishedAt: "2026-10-27T10:01:00.000Z",
    datasetId: "DatasetTest0000001",
    chargedEventCounts: { "busca-por-imagem": 1 },
    usageTotalUsd: 0.004,
    maxTotalChargeUsd: 1,
    ...overrides,
  };
}
