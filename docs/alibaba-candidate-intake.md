# Alibaba.com candidate intake (operator-assisted)

How real Alibaba.com candidates enter the system today, and what an automatic provider would need. Checked on 2026-10-26.

## 1. Integration boundary: what Alibaba publicly documents

| Source | What it documents | Usable by us? |
| --- | --- | --- |
| [Alibaba.com Open Platform](https://openapi.alibaba.com/doc/doc.htm) and its [API reference](https://openapi.alibaba.com/doc/api.htm) | A developer program built around suppliers (Global Gold Supplier, GGS, sellers). Developers register an app, are reviewed, receive an App Key and App Secret, and need API permissions. Each **seller** must authorize the app through an OAuth-style flow before it can call APIs on their behalf. The documented scope is a seller's own product and order data. | **Not for buyer-side discovery.** We found no publicly documented marketplace-wide product search or image search API for buyers. |
| [Alibaba Lens](https://sale.alibaba.com/p/lens/) | Alibaba.com's official **browser extension**: take a screenshot of a product image and see similar items, optionally refined with text. Free to use. | **Only by hand.** The page mentions no developer API or programmatic access. |
| Alibaba.com website search | Keyword search, and search by image in the site's search bar (described in Alibaba's own seller-blog guides). | **Only by hand**, as a user. |

**Not verified:**
- **API reference contents.** The reference page renders client-side and could not be read automatically. A search snippet lists categories including "Product", "Buyer" and "Seller", but their contents, eligibility and terms are unconfirmed.
- **Buyer or partner programs.** Whether Alibaba.com offers a buyer, agent or partner program with search access (for example to approved sourcing partners) would need a direct enquiry.

**Excluded:** third-party "Alibaba search" or "image search" APIs and scraper services. They are unofficial; using them would mean scraping or unapproved access, which `AGENTS.md` forbids. The [1688 image-search API](https://developer.aliyun.com/article/1719255) mentioned by Alibaba Cloud articles is for 1688.com, a different marketplace.

**Conclusion:** no authorized automatic discovery API for our use has been established, so none is implemented. Candidates are found by a person using Alibaba.com's own tools and imported from a manifest.

## 2. The operator-assisted workflow

```
saved GPT-6 Luna run record (evals/local/predictions/<case>.json)
  → pnpm source:candidates --case <case> --prepare     handoff + blank manifest (offline)
  → operator searches on Alibaba.com / Alibaba Lens and fills in the manifest
  → pnpm source:candidates --case <case> --validate    offline validation
  → pnpm source:candidates --case <case> --run          SourcingPipeline with:
        SavedFingerprintImageUnderstandingService   (replays the saved fingerprint; no model call)
        CuratedAlibabaDiscoveryAdapter              (normalizes the manifest; searches nothing)
        UnassessedVisualVerificationService         (returns no assessments: "not assessed")
        ProvisionalRankingService                   (placeholder; without assessments it orders by listing id)
```

- **Prepare** prints the reference id, category, saved queries (unchanged) and distinctive features, plus the Alibaba Lens and Alibaba.com entry points and step-by-step instructions. It writes a blank manifest (`capture.status: "not_started"`) to `evals/local/candidates/<case>.json` and never overwrites one.
- **Manifest location:** `evals/local/` is git-ignored, so genuine listings stay private.
- **Exit codes:**
  - `0`: OK.
  - `1`: invalid manifest or record, or the run failed.
  - `2`: usage error, or missing input. Missing input means no run record, no manifest, or a manifest still `not_started`.
- **Missing input is not an empty result.** A missing or unfilled manifest is reported as missing input. A `completed` manifest with no candidates records a real empty search and produces an empty discovery result.

## 3. Manifest format

The synthetic example is [`evals/candidates/synthetic/syn-bed-001.json`](../evals/candidates/synthetic/syn-bed-001.json). The schema is `discovery/curated/manifest.ts`. In optional fields, `null` and omission both mean "not recorded".

| Part | Fields |
| --- | --- |
| Header | `manifestType: "alibaba_candidate_manifest"`, `schemaVersion: 1`, `dataSource` (`live` genuine, `mock` synthetic only), `caseId`, `referenceImageId`, `fingerprintId` (all filled by `--prepare`) |
| `capture` | `status` (`not_started` / `completed`), `method: "operator_assisted"`, `capturedAt` (required when completed), `tools` (`alibaba_lens`, `alibaba_image_search`, `alibaba_keyword_search`, `other`), `queriesTyped`, `notes` |
| `candidates[]` | **Required:** `listingUrl`, `title`, `images` (may be empty). **Optional:** `marketplaceProductId`, `category`, `attributes` (seller-reported, as shown), `price` `{min, max?, currency?, unit?}`, `minimumOrder` `{quantity, unit?}`, `supplierRef`, `capturedAt`, `foundWith`, `notes` |
| `images[]` | `{ "url": "https://…" }` for a listing image, or `{ "localPath": "<case>/<file>.png" }` for a screenshot saved next to the manifest. Plus optional `role`, `alt`, `mimeType` |
| `suppliers[]` | **Required:** `ref`, `name`. **Optional:** `profileUrl`, `countryCode`, `location`, `classification` (as stated, e.g. `manufacturer`), `verifications` (`{type, status, reportedBy}`, with `reportedBy` required), `platformTenureYears`, `tradeAssurance` `{available, limit?}`, `responsiveness`, `notes` |

### Validation (offline: URLs are parsed, never fetched)

**Genuine records:**
- Listing and supplier URLs must be `https` on `alibaba.com` or a real subdomain of it.
- Image URLs must be on `alibaba.com` or `alicdn.com`.
- Lookalikes are rejected (`alibaba.com.example.net`, `my-alibaba.com`, `alibaba.co`, punycode hosts), as are credentials and ports in URLs, and other marketplaces (1688.com, aliexpress.com).

**Synthetic records:**
- They must use reserved example domains (`example.com`, `*.example`, `*.test`).
- A real Alibaba.com URL in a synthetic record is rejected.
- `--synthetic` is required to use them, and output is labelled SYNTHETIC.

**Also rejected:**
- missing title or URL, or unknown keys;
- negative prices, `max < min`, non-ISO currency, non-integer or zero MOQ;
- duplicate listings, decided by product id (given, or read from a `/product-detail/…_<id>.html` URL) or canonical URL, never by title;
- a product id that contradicts its URL;
- unknown or duplicate supplier refs;
- local paths that are absolute, contain `..`, or are not jpg, png or webp;
- local files that don't exist;
- a manifest whose case, reference or fingerprint differs from the saved run;
- genuine candidates attached to a synthetic fingerprint.

## 4. Normalization and provenance

- **Listings** become existing `CandidateListing` records:
  - id `alibaba-product-<id>`, or `alibaba-url-<hash>` when there is no product id; synthetic ids are prefixed `synthetic-`;
  - images keep their URLs, and local evidence becomes `local-evidence:<path>`.
- **Suppliers** become `SupplierProfile` records. They are merged across manifests only when they share a profile URL, never because their names are similar.
- **Provenance** on every record is `{ marketplace: "alibaba", dataSource, retrievedAt: <capture time>, acquisitionMethod: "operator_assisted" }`.
  - The discovery provider is `curated-alibaba`, with `acquisitionMethod: "operator_assisted"`.
  - `queriesUsed` is `[]`, because this application ran no query.
  - `acquisitionMethod` is a new optional field on `DataProvenance` and `DiscoveryProviderInfo`.
- **Supplier information is a record of what Alibaba.com displayed, not a check by us.**
  - A badge is stored only if the operator saw it, with `reportedBy`.
  - Missing verification means *unknown*, never "not verified".
- **Duplicates** within a manifest are validation errors. Across several manifests for one case, the first listing is kept and the rest are reported.
- **Missing fields** are listed for each listing and supplier.

## 5. What remains unknown or unimplemented

- **Unknown unless the operator records it:** product ids for non-product-detail URLs, categories, prices, MOQ, and every supplier field.
- **Not checked by us:** no listing content or supplier claim is independently verified.
- **No detailed visual verification yet:** no GPT-6.1 Sol verification, and no design similarity index, confidence or match classification. Every candidate is reported as **not assessed**. Local candidate images can be ranked by SigLIP 2 embedding similarity with `pnpm shortlist:images` ([visual-shortlisting.md](visual-shortlisting.md)); that is a retrieval signal, not an assessment.
  - Candidates with no images are flagged as unsuitable for visual comparison.
  - The provisional rank is a placeholder.
- **Images aren't downloaded.** Listing image URLs are kept as references. Only operator-saved local images are used for embeddings; fetching remote images would be a separately approved step.

## 6. Replacing the curated adapter with an authorized provider

> Since P1-004, automated discovery through a third-party provider exists alongside this workflow; it writes the same manifest format with `capture.method: "provider_api"`. See [automated-marketplace-discovery.md](automated-marketplace-discovery.md). An official Alibaba.com integration would still follow the steps below.

1. **Establish access in writing:** a documented Alibaba.com API or partner agreement that permits buyer-side product search (keyword and/or image), plus its rate limits, data-retention and display terms.
2. **Implement it as another `AlibabaDiscoveryAdapter`:**
   - It maps the provider's response to `CandidateListing` / `SupplierProfile`, sets `dataSource: "live"` and `acquisitionMethod: "provider_api"`, and reports the queries and category it actually sent.
   - It needs an adapter-level raw-response schema and mapping, as for GPT-6 Luna.
   - It should have explicit cost and retry policy, and credentials only from env files.
3. **Swap it in at the composition root,** in place of `CuratedAlibabaDiscoveryAdapter`. `SourcingPipeline` and the validation between stages stay unchanged.
4. **Keep the curated adapter** for building labelled evaluation sets and as a fallback when the API is unavailable.
