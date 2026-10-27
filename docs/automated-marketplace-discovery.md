# Automated marketplace discovery

How `pnpm discover:marketplace` finds Alibaba.com candidates for a reference without manual searching, and what has and has not been established. Written for P1-004 on 2026-10-27.

**Status: implemented, awaiting an authorized live provider test.** No provider request has been made. Image search through this provider is advertised, not validated.

```
saved Luna fingerprint + reference photo (hash-checked)
  → provider search: Apify Actor scrapewise/alibaba-com-scraper (image, keyword or hybrid; one capped run per mode)
  → run.json journal + raw provider snapshots (evals/local/discovery/<case>/<discovery id>/)
  → row validation → listing / supplier normalization → de-duplication
  → provider_api candidate manifest <case>.json  (same format as operator-assisted manifests)
  → optional bounded image caching → <case>/<sha>.<ext>
  → existing source:candidates, shortlist:images (SigLIP 2) and verify:visual (Sol) via --candidates <run folder>
```

## 1. Provider selection

| Option | Finding (2026-10-27) | Used? |
|---|---|---|
| Alibaba.com Open Platform ([docs](https://openapi.alibaba.com/doc/doc.htm)) | Still no publicly documented buyer-side product or image search endpoint that our account can use. The API reference renders client-side and could not be read. Same conclusion as [alibaba-candidate-intake.md](alibaba-candidate-intake.md). | No. Preferred if access is confirmed. |
| Alibaba Cloud Image Search | Searches an image gallery you build yourself, not Alibaba.com's catalogue. | No |
| [Apify: scrapewise/alibaba-com-scraper](https://apify.com/scrapewise/alibaba-com-scraper) | Keyword and image search on Alibaba.com, with a documented input schema and REST API. Selected. | **Yes** |
| [Apify: zen-studio/product-search-by-image](https://apify.com/zen-studio/product-search-by-image) | Image search across Alibaba, 1688 and AliExpress. Not evaluated in depth; one adapter only, as requested. | No |

The selected provider is a **third-party scraper run on Apify, not an official Alibaba.com API**. Records carry `acquisitionMethod: "provider_api"` with `providerSource.access: "third_party_service"`, and nothing it returns counts as verified.

## 2. Verified API capabilities

Taken from the Actor's published OpenAPI document (build 0.1.6, `api.apify.com/v2/actors/wxQbYW3Ye1x457taG/builds/LRKicL4g1HrShHdHH/openapi.json`) and its public metadata.

**Inputs we use:**

| Input | Notes |
|---|---|
| `keywords` | |
| `imageUrls` | "Any public JPG, PNG or WebP up to 10 MB" |
| `imageFile` | An untyped string; its encoding is undocumented |
| `maxItems` | |
| `maxItemsPerKeyword` | |
| `maxResultsPerImage` | ≤ 100 |
| `searchType` | `"products"` |
| `includeDetails` | `false`, so no product-page enrichment |

**Output rows:** `type` (`product`, `supplier` or `error`) plus documented fields:
- product: `productId`, `title`, `url`, `priceMin`, `priceMax`, `currency`, `priceTiers`, `minOrderQuantity`, `unit`, `imageUrl`, `images`, `isAd`, `position`, `searchInput`, `searchedAs`, `scrapedAt`;
- `supplier`: `companyName`, `country`, `goldSupplierYears`, `verified`, `tradeAssurance`, `responseRate` and others.

The nested shapes of `priceTiers` and of the supplier link are not documented. The normalizer accepts only shapes it recognizes and drops the rest with a warning.

**Pricing:** pay-per-event, published since 2026-10-18.
- **Image search:** $0.004 per image, covering the first 60 products.
- **Results:** $0.001 per product delivered.
- **Free:** error rows, duplicates and filtered products are not charged.

**Platform API** ([docs](https://docs.apify.com/api/v2)):
- **Authentication:** an `Authorization: Bearer` token. Apify recommends the header over the `?token=` query parameter.
- **Starting a run:** `POST /acts/{actor}/runs` with `timeout`, `maxItems` and `maxTotalChargeUsd`, a hard cost cap across all pricing models.
- **Other endpoints used:** `GET /actor-runs/{id}?waitForFinish=…` (at most 60 s), `GET /datasets/{id}/items?format=json&clean=true&limit=…`, and key-value store record upload and delete.

**Maturity:** the Actor is very new: build 0.1.6 published 2026-10-25, 2 users and 35 runs.

## 3. Data-use and access limitations (unresolved: review before any live run)

- **Alibaba.com terms.** A secondary source states that Alibaba.com's Terms of Use prohibit systematic retrieval of site content (by robots, spiders or manual processes) to compile a collection or database without written permission. I could not read the primary terms page: it renders client-side, and the old URL now redirects to `rulechannel.alibaba.com`. Treat this as **not resolved**.
  - `robots.txt` allows crawlers on `/product-detail/` and `/showroom/` and disallows some search paths (for example `/searchweb/*.html`). It is crawler etiquette, not a grant of permission.
- **Provider behaviour.** The Actor's own proxy setting says it uses "a fresh IP whenever Alibaba.com refuses one" and "switches to residential IPs by itself" when refused. That is the provider working around refusals. Our application implements no CAPTCHA solving, anti-bot evasion, proxy rotation or undocumented endpoints, but using this provider relies on that behaviour. Decide whether that is acceptable.
- **Project rule.** `AGENTS.md` says Alibaba discovery must use "a confirmed, authorized integration (official API or approved partner). No scraping." Using this provider live requires the project owner to decide that it is an approved partner, or to change that rule. The code keeps live use behind an explicit `--data-use-reviewed` acknowledgement.
- **Apify's terms and the Actor's own terms** have not been reviewed here.
- **Images:** listing images are Alibaba.com and seller content. Caching them is a separate, explicit step (`--download-images` or `--fetch-images`) for private evaluation only.

## 4. Account and credential setup

1. Create an Apify account and an API token (Apify Console → Settings → API & Integrations).
2. Add it to `apps/web/.env.local` (git-ignored) as `APIFY_TOKEN=...`. `.env.example` lists the variable with no value.
3. **How the token is handled:**
   - it is only sent in the `Authorization` header, never in URLs;
   - it is never written to `run.json`, snapshots, manifests or summaries (tests check this);
   - the dry run reports only whether it is set.

## 5. Image submission and privacy

Image search requires sending the reference photograph to the provider, so `--authorize-image-upload` is required. Choose a transport explicitly:

- **`--image-transport url --image-url <https URL>` (recommended).**
  - Use a URL you already host and are allowed to share. It is sent as `imageUrls`, which is the documented path.
  - Before any provider request, the CLI downloads the URL once, with the same safety rules as below, and refuses to continue unless its SHA-256 equals the reference hash.
  - The CLI never publishes the photo for you.
- **`--image-transport apify-storage`.**
  - The photo is uploaded to a new, unnamed key-value store in your own Apify account, and the record URL is sent as `imageFile`.
  - **Unverified with this Actor:** its `imageFile` handling is undocumented beyond "upload a product photo".
  - Unnamed stores are typically readable by anyone who knows their id, depending on your Apify account's resource-access setting. The store is deleted after the run reaches a final state, and the deletion time is recorded in `run.json`. A failed deletion is reported so you can delete it yourself.

If image submission does not work in the first live test, use keyword mode. Do not consider image search validated until a real image run returns products.

## 6. Search modes

| Mode | Provider runs | Input |
|---|---|---|
| `image` | 1 | The reference photo; `maxResultsPerImage = maxItems = --max-results` |
| `keyword` | 1 | The first `--max-queries` (default 2, max 4) saved Luna queries, unchanged; `maxItemsPerKeyword = ceil(max / queries)` |
| `hybrid` | 2, budgeted separately | Image run plus keyword run, with the cost cap split evenly |

Keyword results are not assumed to be visually accurate. Discovery never scores similarity or ranks results.

## 7. Dry run

```sh
pnpm discover:marketplace --case ettrick-bed --provider apify --mode image --dry-run
pnpm discover:marketplace --case ettrick-bed --provider apify --mode keyword --dry-run
pnpm discover:marketplace --case ettrick-bed --provider apify --mode hybrid --image-transport apify-storage --dry-run
```

**Shows:**
- the reference, with its type, size, dimensions and verified hash, and the fingerprint;
- the provider, and a warning that it is not an official API;
- the planned runs with the exact Actor input;
- the queries;
- the worst-case charge against the cap;
- whether the token is present;
- image-submission readiness and the image-download policy;
- the output location.

**No network:** no provider request, upload or image fetch is made.

## 8. Live authorization

All of these are required, and nothing defaults to live:

| Requirement | Detail |
|---|---|
| `--live` | |
| `--provider apify` | |
| `--mode` | |
| `--max-results` | 1–50 |
| `--max-provider-cost-usd` | Above 0 and ≤ 10 |
| `--data-use-reviewed` | You have reviewed section 3 |
| `APIFY_TOKEN` | Set in the environment |
| `--authorize-image-upload` and `--image-transport` | Image and hybrid modes only |

First smoke test: one image search with up to 10 products and no keyword run:

```sh
pnpm discover:marketplace --case ettrick-bed --provider apify --mode image --live \
  --max-results 10 --max-provider-cost-usd 0.25 --data-use-reviewed \
  --authorize-image-upload --image-transport url --image-url <https URL serving ettrick.png>
```

(Or `--image-transport apify-storage` instead of the URL options. Add `--download-images` to cache one image per product.)

## 9. Cost controls

| Control | How it works |
|---|---|
| Hard provider cap | Apify `maxTotalChargeUsd` on every run, plus `maxItems` |
| Cap must cover the estimate | The cap, or each hybrid share, must cover the worst-case estimate at published prices, or nothing starts |
| Run timeout | 300 s (Apify `timeout`) |
| Bounded reads | The dataset read is limited to `3 × max + 20` rows (at most 500) |
| No retried starts | A start request is never retried. If its answer is lost (timeout, network or 5xx), the run is recorded as `start_uncertain` and the command stops (exit 5). `--resume` lists recent runs so you can attach the right one with `--provider-run-id`, and never starts a new run. |
| Bounded polling | Polling is read-only and bounded; it tolerates up to 3 transient errors |
| Stop on access errors | An `authentication`, `payment_required`, `permission` or `rate_limit` error stops the remaining modes |
| Reported charges | Actual charges (`usageTotalUsd`, `chargedEventCounts`) are recorded per run when Apify reports them |

Platform usage on pay-per-event Actors is not included in the estimate. The `maxTotalChargeUsd` cap applies across all pricing models.

## 10. Normalization

Rows are checked one by one with Zod (`normalize.ts`):

| Row | Result |
|---|---|
| `error` | Counted as a provider error with its code; never a product |
| Not an object, wrong type, missing title, bad URL, product id contradicting the URL, or duplicate | Rejected with a reason |
| Mostly unrecognisable rows, or no `type` field at all | A response-wide `ProviderSchemaError`; never "no results" |

| Field | Mapping |
|---|---|
| Listing URL | `//` → `https:`; query and fragment removed; must be `alibaba.com` or a real subdomain (lookalikes rejected) |
| Product id | Numeric, at least 6 digits; must match the `/product-detail/…_<id>.html` id when both exist |
| Images | `imageUrl` + `images`, only on `alibaba.com`/`alicdn.com`, de-duplicated, at most 10; the first is `primary` |
| Price | `priceMin`/`priceMax`/`currency` (ISO code)/`unit`; omitted when absent; a missing currency stays missing (warning) |
| Price tiers | Recognised `{minQuantity, maxQuantity, price}` shapes only |
| MOQ | Positive integer `minOrderQuantity` with `unit` |
| Supplier | `companyName`, a profile URL only if it is on Alibaba.com, a 2-letter `country` → `countryCode` (other values → `location`), `goldSupplierYears` → tenure, `responseRate` "92%" → percent |
| Badges | Only **positive** `verified`/`verifiedPro`/`tradeAssurance` values are recorded, as claims `reportedBy: "alibaba.com (as reported by apify:…)"`. `false` means "not shown", never "not verified". |
| Discovery sources | Per listing: mode, provider run id, keyword query, position, and the sponsored (`isAd`) flag |

**De-duplication:**
- Listings are de-duplicated by product id (or canonical URL), never by title. A product found by both image and keyword search is kept once, with both sources.
- Suppliers merge only on an identical profile URL, never on name.

## 11. Candidate image collection

`--download-images` (with `--live`), or later `--fetch-images <run folder> --data-use-reviewed`. Only image URLs the provider returned are fetched (`safe-image-fetch.ts`, `acquire-images.ts`):

- **Where and how:**
  - HTTPS only, on `alicdn.com` or `alibaba.com` (and subdomains);
  - no IP-literal hosts, credentials or non-standard ports.
- **DNS check:**
  - every DNS answer is checked when connecting, so loopback, private, link-local, CGNAT, metadata (`169.254.169.254`), multicast and documentation ranges are refused;
  - redirects (at most 3) are re-validated.
- **Limits:**
  - 10 MB;
  - 20 s;
  - a declared `image/*` content type;
  - by default, 1 image per listing and at most `max-results × images-per-listing` in total;
  - a URL shared by several listings is fetched once.
- **Content checks:**
  - the format comes from the file's own bytes, not the declared content type;
  - PNG, JPEG and WebP are structure-checked: chunk CRCs and markers, 16–12,000 px per side, 50 MP at most;
  - AVIF is decoded and re-encoded as PNG by `services/vision` (`python -m vfsa_vision convert`, Pillow, with its pixel limits), and the AVIF original is kept unreferenced in `avif-originals/`. Without the vision environment, AVIF images are reported as not cached.
- **Storage:**
  - files are stored under their hash, as `<run folder>/<case>/<sha>.<ext>`;
  - an existing file is reused if its content is identical, and never overwritten otherwise.
- **Failures:** a listing whose image fails keeps its remote URL, gets no local evidence, and gets a note explaining why. Nothing is substituted.

## 12. Offline replay

**Recorded status versus actual state.** A journal's recorded `status: "in_progress"` means "provider runs finished; results not yet normalized into a manifest in this folder". It does **not** mean a provider job is running. Summaries now also print the derived state:
- provider runs by outcome;
- saved snapshots;
- whether any external work is pending;
- whether a manifest was recorded.

A replay is labelled as an offline replay and never changes the journal. The committed synthetic fixture deliberately keeps that `in_progress` state: it has two finished runs and no manifest.

```sh
pnpm discover:marketplace --case <case> --replay <run folder> [--output-dir <new folder>]
```

Re-validates and re-normalizes the saved provider snapshots without any network request. It writes a manifest only to a different folder, never into the run folder.

A synthetic fixture is committed under `evals/discovery/synthetic/`:

```sh
pnpm discover:marketplace --case syn-bed-001 --predictions evals/image-understanding/synthetic/predictions \
  --replay evals/discovery/synthetic/syn-bed-001/disc-2026-10-27T00-00-00Z-000000
```

## 13. Missing data

- **Absent stays absent:** price, currency, MOQ, supplier, country, badges, materials and images are never invented. Unknown values stay absent, and the import summary counts listings without images or image URLs.
- **Errors aren't empty results:** a provider error is reported as an error, not as zero results. A run that genuinely returns nothing produces an empty manifest and is reported as such.

## 14. Private storage

`evals/local/discovery/<case>/<discovery id>/` is git-ignored and contains:

| File | Contents |
|---|---|
| `run.json` | The journal: request, provider runs, states, charges, storage upload |
| `provider-response-<mode>.json` | Bounded raw rows |
| `<case>.json` | The manifest |
| `<case>/` | Cached images |
| `avif-originals/` | AVIF originals, if any |
| `images.json` | Per-image outcomes |
| `import-summary.json` | The import summary |

Writes are atomic. No credentials are stored. Supplier records keep company-level fields only; contact details are not mapped.

## 15. Compatibility with SigLIP 2 and Sol

Point existing commands at the run folder:

```sh
pnpm source:candidates --case ettrick-bed --candidates evals/local/discovery/ettrick-bed/<discovery id> --validate
pnpm shortlist:images  --case ettrick-bed --candidates evals/local/discovery/ettrick-bed/<discovery id> --dry-run
pnpm verify:visual     --case ettrick-bed --candidates evals/local/discovery/ettrick-bed/<discovery id> --dry-run
```

- **SigLIP:** the shortlist uses the cached `localPath` images (role `primary`) under the same evidence rules.
- **Sol:** `verify:visual` records are keyed by listing and image hash, so they don't collide with the existing Ettrick records.
- **Report naming:** reports for an automated set get their own file name, so they never replace the control set's reports. `shortlist:images` writes `<case>-<model>-auto-<provider run id>.json`, and `verify:visual --report` writes `report-auto-<provider run id>.json`.
- **Control set untouched:** the operator-assisted control set (`evals/local/candidates/ettrick-bed.json`) is not modified.

## 16. Replacing the provider with an official integration

1. Confirm in writing an official Alibaba.com API (or an approved partner) that permits buyer-side product and image search, with its rate, retention and display terms.
2. Implement another `AlibabaDiscoveryAdapter` that produces the same `provider_api` manifest, with `capture.provider.access: "official_api"`.
3. Keep the boundary: raw schema → manifest → the existing importer (`importCuratedCandidates`), the existing URL rules and evidence handling. Reuse `run.json`/replay if that API is also asynchronous.
4. Remove or retain the Apify adapter as a documented fallback, according to the access decision in section 3.
