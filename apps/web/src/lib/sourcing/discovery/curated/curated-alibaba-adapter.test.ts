import { describe, expect, it } from "vitest";
import type { ReferenceImage } from "../../domain";
import { discoverySearchResultSchema } from "../../validation/discovery";
import {
  CandidateAssociationError,
  CuratedAlibabaDiscoveryAdapter,
  importCuratedCandidates,
  MissingCandidateInputError,
} from "./curated-alibaba-adapter";
import { candidateManifestSchema, createManifestTemplate, type CandidateManifest } from "./manifest";
import { liveShapedManifest, SYN_FINGERPRINT, SYN_REFERENCE, syntheticManifest } from "./test-fixtures";

const parse = (m: CandidateManifest) => candidateManifestSchema.parse(m);

const reference = (id = SYN_REFERENCE): ReferenceImage => ({
  id,
  image: { uri: "sha256:test" },
  origin: { kind: "unknown" },
  submittedAt: "2026-10-26T08:00:00.000Z",
});

async function discover(manifests: CandidateManifest[], limit = 20, ref = reference()) {
  const adapter = new CuratedAlibabaDiscoveryAdapter({ manifests: manifests.map(parse) });
  const result = await adapter.discoverCandidates({ reference: ref, mode: "image_and_text", limit });
  return { adapter, result };
}

describe("CuratedAlibabaDiscoveryAdapter", () => {
  it("returns a schema-valid discovery result that says no search was performed", async () => {
    const { result } = await discover([syntheticManifest()]);
    expect(discoverySearchResultSchema.safeParse(result).success).toBe(true);
    expect(result.provider).toEqual({
      providerId: "curated-alibaba",
      marketplace: "alibaba",
      dataSource: "mock",
      acquisitionMethod: "operator_assisted",
    });
    expect(result.queriesUsed).toEqual([]);
    expect(result.categoryUsed).toBeUndefined();
    expect(result.retrievedAt).toBe("2026-10-26T09:00:00.000Z");
  });

  it("normalizes listings with capture provenance and keeps distinct listings that share a title", async () => {
    const { result } = await discover([syntheticManifest()]);
    expect(result.listings.map((l) => l.id)).toEqual([
      "synthetic-alibaba-product-1000000000001",
      "synthetic-alibaba-product-1000000000002",
      expect.stringMatching(/^synthetic-alibaba-url-[0-9a-f]{16}$/),
    ]);
    const [first] = result.listings;
    expect(first).toMatchObject({
      marketplaceProductId: "1000000000001",
      price: { min: 100, max: 150, currency: "USD", unit: "piece" },
      minimumOrder: { quantity: 2 },
      attributes: { Material: "Wood" },
      images: [{ uri: "https://img.example.com/1.jpg", role: "primary" }],
      provenance: {
        marketplace: "alibaba",
        dataSource: "mock",
        retrievedAt: "2026-10-26T09:00:00.000Z",
        acquisitionMethod: "operator_assisted",
      },
    });
  });

  it("marks genuine operator records as live and keeps real Alibaba.com URLs untouched", async () => {
    const m = liveShapedManifest();
    const { result } = await discover([m], 20, reference("ref-test-live"));
    expect(result.provider.dataSource).toBe("live");
    expect(result.listings[0]).toMatchObject({
      id: "alibaba-product-0000000001",
      listingUrl: m.candidates[0].listingUrl,
      provenance: { dataSource: "live", acquisitionMethod: "operator_assisted" },
    });
  });

  it("preserves listing-to-supplier links and never invents supplier details", async () => {
    const { result } = await discover([syntheticManifest()]);
    const [a, b, c] = result.listings;
    const byId = new Map(result.suppliers.map((s) => [s.id, s]));
    expect(byId.get(a.supplierId!)?.name).toBe("[SYNTHETIC] Supplier A");
    expect(byId.get(b.supplierId!)?.name).toBe("[SYNTHETIC] Supplier B");
    expect(c.supplierId).toBeUndefined();
    const nameOnly = byId.get(b.supplierId!)!;
    expect(Object.keys(nameOnly).sort()).toEqual(["id", "name", "provenance"]);
  });

  it("reports missing fields and listings without image evidence", async () => {
    const { adapter } = await discover([syntheticManifest()]);
    const [full, bare, noId] = adapter.lastImport!.info;
    expect(full.missingFields).toEqual(["category"]);
    expect(bare.imageEvidence).toEqual({ remote: 0, local: 0, suitableForVisualComparison: false });
    expect(bare.missingFields).toEqual(["category", "attributes", "price", "minimumOrder", "images"]);
    expect(noId.missingFields).toContain("marketplaceProductId");
    expect(noId.missingFields).toContain("supplier");
  });

  it("keeps local evidence references for the visual-matching stage", async () => {
    const m = syntheticManifest();
    m.candidates[1] = { ...m.candidates[1], images: [{ localPath: "syn-bed-001/listing-2.png", role: "operator_screenshot" }] };
    const { adapter, result } = await discover([m]);
    expect(result.listings[1].images).toEqual([{ uri: "local-evidence:syn-bed-001/listing-2.png", role: "operator_screenshot" }]);
    expect(adapter.lastImport!.info[1].imageEvidence).toEqual({ remote: 0, local: 1, suitableForVisualComparison: true });
  });

  it("respects the limit and returns only suppliers of returned listings", async () => {
    const { adapter, result } = await discover([syntheticManifest()], 1);
    expect(result.listings).toHaveLength(1);
    expect(result.suppliers.map((s) => s.name)).toEqual(["[SYNTHETIC] Supplier A"]);
    expect(adapter.lastImport!.excludedByLimit).toBe(2);
    await expect(discover([syntheticManifest()], 0)).rejects.toThrow(RangeError);
  });

  it("deduplicates the same product across manifests and merges suppliers only by profile URL", async () => {
    const first = syntheticManifest();
    const second = syntheticManifest({
      capture: { ...first.capture, capturedAt: "2026-10-26T10:00:00.000Z" },
      suppliers: [
        { ref: "other-ref", name: "[SYNTHETIC] Supplier A renamed", profileUrl: "https://SUPPLIER-A.example.com/?x=1" },
        { ref: "supplier-b", name: "[SYNTHETIC] Supplier B" },
      ],
      candidates: [
        { ...first.candidates[0], listingUrl: "https://shop.example.com/product-detail/Renamed_1000000000001.html", supplierRef: "other-ref" },
        { listingUrl: "https://shop.example.com/product-detail/New_1000000000009.html", title: "[SYNTHETIC] New", images: [], supplierRef: "supplier-b" },
      ],
    });
    const { adapter, result } = await discover([first, second]);
    expect(result.listings).toHaveLength(4);
    expect(adapter.lastImport!.skippedDuplicates).toEqual([
      { identity: "product:1000000000001", keptListingId: "synthetic-alibaba-product-1000000000001", manifestIndex: 1, candidateIndex: 0 },
    ]);
    // Same name "Supplier B" in both manifests without a profile URL: kept as two suppliers.
    const supplierBs = result.suppliers.filter((s) => s.name === "[SYNTHETIC] Supplier B");
    expect(supplierBs).toHaveLength(2);
    expect(result.retrievedAt).toBe("2026-10-26T10:00:00.000Z");
  });

  it("returns an empty result for a completed search with no candidates", async () => {
    const { result } = await discover([syntheticManifest({ candidates: [], suppliers: [] })]);
    expect(result.listings).toEqual([]);
    expect(result.suppliers).toEqual([]);
  });

  it("treats an unfilled template or no manifest as missing input", async () => {
    const template = createManifestTemplate({ caseId: "syn-bed-001", referenceImageId: SYN_REFERENCE, fingerprintId: SYN_FINGERPRINT, dataSource: "mock" });
    await expect(discover([template])).rejects.toThrow(MissingCandidateInputError);
    expect(() => importCuratedCandidates([])).toThrow(MissingCandidateInputError);
  });

  it("rejects manifests for another reference or fingerprint, and mixed data sources", async () => {
    await expect(discover([syntheticManifest()], 20, reference("ref-other"))).rejects.toThrow(CandidateAssociationError);
    const adapter = new CuratedAlibabaDiscoveryAdapter({ manifests: [parse(syntheticManifest())] });
    const fingerprint = { id: "fp-other" } as never;
    await expect(adapter.discoverCandidates({ reference: reference(), fingerprint, mode: "image", limit: 5 })).rejects.toThrow(
      CandidateAssociationError,
    );
    expect(() => importCuratedCandidates([parse(syntheticManifest()), parse(liveShapedManifest())])).toThrow(CandidateAssociationError);
  });

  it("is deterministic and does not mutate its input", async () => {
    const m = parse(syntheticManifest());
    const before = structuredClone(m);
    const a = await new CuratedAlibabaDiscoveryAdapter({ manifests: [m] }).discoverCandidates({ reference: reference(), mode: "text", limit: 5 });
    const b = await new CuratedAlibabaDiscoveryAdapter({ manifests: [m] }).discoverCandidates({ reference: reference(), mode: "image", limit: 5 });
    expect(a).toEqual(b);
    expect(m).toEqual(before);
  });
});
