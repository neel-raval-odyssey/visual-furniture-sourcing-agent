import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidateIdentity, candidateManifestSchema, createManifestTemplate, type CandidateManifest } from "./manifest";
import { checkMarketplaceUrl, productIdFromListingUrl } from "./marketplace-urls";
import { liveShapedManifest, REPO_ROOT, syntheticManifest } from "./test-fixtures";

function issues(m: unknown): string[] {
  const parsed = candidateManifestSchema.safeParse(m);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

const withCandidate = (base: CandidateManifest, patch: Record<string, unknown>, index = 0) => ({
  ...base,
  candidates: base.candidates.map((c, i) => (i === index ? { ...c, ...patch } : c)),
});

describe("candidate manifest", () => {
  it("accepts the committed synthetic sample and the test fixtures", () => {
    const sample = JSON.parse(readFileSync(`${REPO_ROOT}evals/candidates/synthetic/syn-bed-001.json`, "utf8"));
    expect(issues(sample)).toEqual([]);
    expect(issues(syntheticManifest())).toEqual([]);
    expect(issues(liveShapedManifest())).toEqual([]);
  });

  it("accepts a blank template and an empty completed search", () => {
    const template = createManifestTemplate({ caseId: "x", referenceImageId: "r", fingerprintId: "f", dataSource: "live" });
    expect(issues(template)).toEqual([]);
    expect(issues(liveShapedManifest({ candidates: [], suppliers: [] }))).toEqual([]);
  });

  it("requires a completed capture to have a time, and a template to have no candidates", () => {
    const m = syntheticManifest();
    expect(issues({ ...m, capture: { ...m.capture, capturedAt: null } }).join()).toContain("capture.capturedAt");
    expect(issues({ ...m, capture: { ...m.capture, status: "not_started", capturedAt: null } }).join()).toContain("capture.status");
  });

  it("rejects missing essential listing information and unknown keys", () => {
    const m = syntheticManifest();
    const { title: _title, ...noTitle } = m.candidates[0];
    void _title;
    expect(issues({ ...m, candidates: [noTitle] }).join()).toContain("candidates.0.title");
    expect(issues(withCandidate(m, { listingUrl: "" })).join()).toContain("candidates.0.listingUrl");
    expect(issues(withCandidate(m, { similarity: 90 })).join()).toMatch(/unrecognized|Unrecognized/);
  });

  it("rejects malformed URLs", () => {
    const m = liveShapedManifest();
    for (const listingUrl of ["not a url", "http://www.alibaba.com/product-detail/x_0000000001.html", "ftp://www.alibaba.com/x"]) {
      expect(issues(withCandidate(m, { listingUrl })).join(), listingUrl).toContain("listingUrl");
    }
  });

  it.each([
    "https://alibaba.com.example.net/product-detail/x_0000000001.html",
    "https://my-alibaba.com/product-detail/x_0000000001.html",
    "https://www.alibaba.co/product-detail/x_0000000001.html",
    "https://www.xn--libaba-2nf.com/product-detail/x_0000000001.html",
    "https://www.alibaba.com.@evil.example/x",
    "https://user:pass@www.alibaba.com/x",
    "https://www.alibaba.com:8443/x",
    "https://www.alibaba.com./x",
    "https://detail.1688.com/offer/0000000001.html",
    "https://www.aliexpress.com/item/0000000001.html",
  ])("rejects a lookalike or non-Alibaba.com listing host: %s", (listingUrl) => {
    expect(issues(withCandidate(liveShapedManifest(), { listingUrl })).join()).toContain("candidates.0.listingUrl");
  });

  it("accepts genuine Alibaba.com subdomains", () => {
    for (const url of ["https://www.alibaba.com/x", "https://alibaba.com/x", "https://m.alibaba.com/x", "https://somefactory.en.alibaba.com/"]) {
      expect(checkMarketplaceUrl(url, "listing", "live"), url).toBeNull();
    }
    expect(checkMarketplaceUrl("https://s.alicdn.com/a.jpg", "listing_image", "live")).toBeNull();
    expect(checkMarketplaceUrl("https://s.alicdn.com/a", "listing", "live")).not.toBeNull();
  });

  it("keeps synthetic and genuine records apart", () => {
    // Synthetic records may not use real Alibaba.com URLs...
    expect(issues(withCandidate(syntheticManifest(), { listingUrl: "https://www.alibaba.com/x" })).join()).toContain("reserved example domain");
    // ...and genuine records may not use example domains.
    expect(issues(liveShapedManifest({ dataSource: "live", candidates: syntheticManifest().candidates, suppliers: [] })).join()).toContain(
      "is not alibaba.com",
    );
  });

  it("rejects image URLs outside Alibaba.com and its image CDN, and malformed local paths", () => {
    const m = liveShapedManifest();
    expect(issues(withCandidate(m, { images: [{ url: "https://img.example.com/1.jpg" }] })).join()).toContain("images.0.url");
    expect(issues(withCandidate(m, { images: [{ url: "https://alicdn.com.evil.example/1.jpg" }] })).join()).toContain("images.0.url");
    for (const localPath of ["/Users/someone/a.png", "../outside.png", "case/../../a.png", "notes.txt", "C:\\a.png", "a.gif"]) {
      expect(issues(withCandidate(m, { images: [{ localPath }] })).join(), localPath).toContain("images.0");
    }
    expect(issues(withCandidate(m, { images: [{ localPath: "test-live-bed/listing-1.png" }] }))).toEqual([]);
    expect(issues(withCandidate(m, { images: [{ url: "https://s.alicdn.com/a.jpg", localPath: "a.png" }] }))).not.toEqual([]);
  });

  it("rejects invalid numeric values", () => {
    const m = syntheticManifest();
    const bad: Record<string, unknown>[] = [
      { price: { min: -1 } },
      { price: { min: 10, max: 5 } },
      { price: { min: "10" } },
      { price: { min: 10, currency: "usd" } },
      { minimumOrder: { quantity: 0 } },
      { minimumOrder: { quantity: 1.5 } },
    ];
    for (const patch of bad) expect(issues(withCandidate(m, patch)), JSON.stringify(patch)).not.toEqual([]);
    const supplier = { ...m.suppliers[0], platformTenureYears: -2 };
    expect(issues({ ...m, suppliers: [supplier, m.suppliers[1]] }).join()).toContain("platformTenureYears");
  });

  it("rejects duplicate listing identities but keeps distinct listings with the same title", () => {
    const m = syntheticManifest();
    expect(m.candidates[0].title).toBe(m.candidates[1].title);
    expect(issues(m)).toEqual([]);

    // Same product id under a different URL slug and query string.
    const dup = { ...m.candidates[0], listingUrl: "https://shop.example.com/product-detail/Other-Title_1000000000001.html?spm=x" };
    expect(issues({ ...m, candidates: [...m.candidates, dup] }).join()).toContain("Duplicate listing");
    // Same canonical URL without a product id.
    const dupUrl = { ...m.candidates[2], listingUrl: "https://SHOP.example.com/listing/no-id/?ref=1#top" };
    expect(issues({ ...m, candidates: [...m.candidates, dupUrl] }).join()).toContain("Duplicate listing");
  });

  it("rejects a product id that contradicts the listing URL", () => {
    expect(issues(withCandidate(syntheticManifest(), { marketplaceProductId: "999999999" })).join()).toContain("marketplaceProductId");
  });

  it("rejects invalid supplier references", () => {
    const m = syntheticManifest();
    expect(issues(withCandidate(m, { supplierRef: "supplier-z" })).join()).toContain("supplierRef");
    expect(issues({ ...m, suppliers: [m.suppliers[0], { ...m.suppliers[1], ref: "supplier-a" }] }).join()).toContain("Duplicate supplier ref");
    expect(issues({ ...m, suppliers: [{ ...m.suppliers[0], name: "" }, m.suppliers[1]] }).join()).toContain("suppliers.0.name");
  });

  it("preserves incomplete supplier information and requires a source for verification claims", () => {
    const m = syntheticManifest({ suppliers: [{ ref: "supplier-a", name: "[SYNTHETIC] Name only" }, { ref: "supplier-b", name: "B" }] });
    expect(issues(m)).toEqual([]);
    const claim = { ref: "supplier-a", name: "A", verifications: [{ type: "verified_supplier", status: "verified" }] };
    expect(issues({ ...m, suppliers: [claim, m.suppliers[1]] }).join()).toContain("reportedBy");
  });

  it("derives listing identity from product ids, never from titles", () => {
    expect(productIdFromListingUrl("https://www.alibaba.com/product-detail/Some-Bed_0000000042.html")).toBe("0000000042");
    expect(productIdFromListingUrl("https://www.alibaba.com/showroom/bed.html")).toBeUndefined();
    expect(candidateIdentity({ listingUrl: "https://www.alibaba.com/product-detail/A_0000000042.html" })).toBe("product:0000000042");
    expect(candidateIdentity({ listingUrl: "https://www.alibaba.com/showroom/bed.html?x=1" })).toBe("url:www.alibaba.com/showroom/bed.html");
  });
});
