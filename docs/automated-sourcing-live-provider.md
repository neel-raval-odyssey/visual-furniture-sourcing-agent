# Automated sourcing: live provider (P1-009)

Written 2026-11-03. This covers automatic product discovery for a newly analysed photo, how it hands off to the existing SigLIP 2 and Sol stages, and how a person runs the first authorized live proof.

**Status: implemented and tested offline. Live use is blocked by project policy**, because the selected provider is an external search index, not an official Alibaba.com API or an approved partner. No live search has been run, so there are no measured live results yet.

## 1. Chosen provider and actual capabilities

| | |
|---|---|
| Provider | Exa Search API, `POST https://api.exa.ai/search` ([reference](https://exa.ai/docs/reference/search)) |
| What it is | A commercial web search index. It is **not** Alibaba.com, not an official Alibaba.com API and not an Alibaba.com partner. |
| How we use it | Keyword search with the photo analysis's saved queries, limited to Alibaba.com product pages with `includeDomains: ["www.alibaba.com/product-detail"]` (the documented "host plus path prefix" form) |
| Request fields sent | `query`, `type: "auto"`, `numResults` (1–10), `includeDomains`, and `contents.highlights {query, maxCharacters: 600}`. Only documented fields are sent. |
| Response fields used | `requestId`, `costDollars.total`; per result: `url`, `title`, `image`, `highlights` (`id` and `publishedDate` are kept for provenance) |
| Not used | `category`: the documented values (company, publication, news, personal site, financial report, people) have no product category. Exa's shopping demo uses `category: "product"`, but the API reference documents it only as a "hint". The `entities` product schema is not documented. `extras.imageLinks` returns gallery images and is not requested. |
| Coverage | Only the Alibaba.com product pages Exa's index has seen. This is not marketplace-wide search, and listings may be outdated or gone. |

Sources checked on 2026-11-03: the API reference, [exa.ai/library/product](https://exa.ai/library/product) (whose FAQ says prices are not live: "Confirm the price on the merchant's page before you buy."), [the shopping demo write-up](https://demos.exa.ai/shopping-demo/how-it-works), [exa.ai/pricing](https://exa.ai/pricing) and the Exa Terms of Service PDF.

The official Alibaba.com Open Platform was not re-researched beyond P1-008's record ([marketplace-source-authorization.md](marketplace-source-authorization.md)). Its documentation still renders client-side and no buyer-side search endpoint was found. No licensed catalogue provider was identified.

## 2. Confirmed rights and limitations

| Question | Evidence | Status |
|---|---|---|
| Discovering Alibaba listing links through the index | Exa ToS §1(b): the customer represents that its use "will not breach any law or any third party's terms" | Exa grants the search service, not Alibaba.com's permission |
| Storing results | Exa ToS §1(c) licenses *Exa* to store user input and output; it does not restrict the customer's storage | Not restricted by Exa. Alibaba.com content rights: **unknown** |
| AI processing of results | No Exa restriction found | Alibaba.com content rights: **unknown** |
| Showing supplier and price information | Exa ToS §6.1: third-party materials are "provided solely as a convenience"; Exa takes no responsibility for "copyright compliance, legality" | **Not established** |
| Downloading, caching and displaying product images (alicdn.com) | Images are Alibaba.com/seller content; Exa gives no rights to them | **Not established**: needs its own approval |
| Commercial use of Alibaba-derived data | Not granted by Exa | **Not established** |

Conclusion: an Exa subscription does not supply the third-party content rights. Under `AGENTS.md` (official API or approved partner only), Exa fails the policy check. It stays disabled until a person decides otherwise and records the evidence (section 15).

## 3. Credentials and setup

- `EXA_API_KEY` goes in `apps/web/.env.local` (git-ignored; see `.env.example`). It is read only on the server, sent only in the `x-api-key` header, and never logged; error text is redacted.
- Eligibility is computed by `discovery/authorization.ts` for provider `exa-alibaba-index`. It requires all of the following:
  - project policy;
  - the key;
  - a reviewed entry in `evals/local/marketplace-access.json` (`accessBasis: "search_index_terms_review"`, mode `keyword`, `liveEnabled: true`, caps).
- Two further approvals are separate:
  - `productImageRetrievalApproved` permits downloading listing images;
  - `retainRawResponses` permits keeping full responses (otherwise only the fields used are saved).
- Today the **policy** check fails. A key or an access record alone cannot enable it.

## 4. Image versus keyword search

This is **keyword search derived from visual understanding**: photo → Luna fingerprint (saved) → its saved search queries → Exa. It is **not** native image-to-image search. The reference photo is never sent; the provider only supports `keyword` mode.

## 5. Candidate normalization

`discovery/providers/exa/normalize.ts` handles results as follows:

- **Each result is validated on its own, offline.** It is kept only when:
  - the URL is https, with no credentials and no port;
  - the host is alibaba.com or a real subdomain of it (lookalikes, 1688.com and aliexpress.com are rejected);
  - the URL is a product-detail page with a numeric product id (search, showroom and supplier pages are rejected);
  - it has a title;
  - the title plausibly describes furniture.
- **Rejected rows are counted with a reason:** `invalid_url`, `not_alibaba`, `not_product_page`, `missing_title`, `not_furniture`, `duplicate` or `over_limit`.
- **Products are deduplicated** by Alibaba.com product id within and across queries. A product found by several queries keeps every discovery source (query, position and request id).
- **The output is a standard `provider_api` candidate manifest**, with `capture.provider.access = "external_search_index"`. It validates with `source:candidates` and is read by the orchestrator, `shortlist:images` and `verify:visual`.
- **Nothing is inferred.**
  - Suppliers are never derived from titles or URLs. Exa reports none, so `suppliers` is empty.
  - Price and minimum order are read only when the indexed excerpt states them explicitly. The currency is set only for an explicit "US$"/"USD"; a bare "$" leaves it unknown. No conversion is made.
  - Prices are labelled "may be stale".
  - A search-index title does not prove the product is available.

## 6. Product-image acquisition

- **Selection:** the only candidate image is each page's preview image as reported by Exa (`image`). Gallery images are not requested, and no Alibaba page is crawled. The reason is recorded in each candidate's notes.
- **Retrieval** is allowed only with `productImageRetrievalApproved`. It reuses `discovery/images/` without changes:
  - https only, with an alicdn.com/alibaba.com allowlist;
  - DNS answers checked at connect time, so private, loopback and metadata addresses are refused;
  - redirects re-validated, with size, time and pixel limits;
  - MIME sniffing and decoding;
  - SHA-256 file names;
  - private storage in the run folder.
- **AVIF** is decoded and re-encoded to PNG by `services/vision` (`discovery/images/avif-converter.ts`); it is never renamed.
- **One image per product,** so SigLIP scores are comparable with the earlier single-image experiments.
- **Products without a usable or permitted image stay as unassessed leads.** No photo is substituted.
- Photos can be prepared later without repeating the search: `--fetch-images` or the web "Prepare product photos" button.

## 7. Supplier-data provenance

| Field | Supplied by Exa? |
|---|---|
| Listing URL, product id, title | Yes, as indexed |
| Preview image URL | Usually |
| Price / MOQ | Only when written in the excerpt; possibly stale |
| Supplier name, profile URL, location, verification badges | **No.** Recorded as unknown, never inferred. |

## 8. Cost and request budgets

- **Request limits:**
  - up to 4 saved queries, each a single request with up to 10 results;
  - up to 20 unique products kept;
  - requests are sent one after another, with no automatic retries.
- **Estimate** from published prices (2026-11-03):
  - $0.007 per search, plus $0.001 per result above 10, plus $0.001 per page of highlights;
  - this gives $0.017 per query and **$0.068 for the 4-query run**.
- **Cap:** the per-run cost cap comes from the access record (default $0.25 for display, hard maximum $1). A request is not sent if it could exceed the cap.
- **Recorded cost:** the charge Exa reports (`costDollars.total`) is what gets recorded.

## 9. Run journals and resume

Each search has its own folder at `evals/local/discovery/<case>/<disc-id>/`:

| File | Contents |
|---|---|
| `run.json` | Status, reference fingerprint id and photo hash, queries, caps, request id, state, cost and error for each request, and the confirmation's request key |
| `provider-response-qN.json` | The used fields per query; full responses only if retention is approved |
| `<case>.json` | The normalized candidate manifest, a separate set; `evals/local/candidates/<case>.json` is never written |
| `images.json` | The outcome for each image |
| `import-summary.json` | Counts, rejections, costs and errors |

Safety rules:

- **Recorded before sending.** A request is recorded as `start_requested` before it is sent.
- **Uncertain requests are never re-sent.** A timeout or network failure is recorded as failed with outcome `uncertain` (it may have been billed). Sending stops at the first access, payment, rate-limit or uncertain failure.
- **One search at a time.** Starts run under a case lock: a repeated request key returns the same search, and a second search is refused while one is unfinished, so refreshing or double-clicking never sends again.
- **Resume never re-sends what may have been sent.** `--resume` settles interrupted requests as uncertain without re-sending them; unsent queries go out only with `--live --confirm-paid-search`.

## 10. SigLIP handoff

- **Comparing a saved search.** "Compare these products" (web) or `source:auto --source provider-run --discovery-run <folder>` runs the existing P1-005 orchestrator over that search's manifest. The model and preprocessing are unchanged: `google/siglip2-base-patch16-384`.
- **What is embedded.** Only products with a cached photo are embedded; the others stay unassessed. There is no cosine cutoff: all products with photos stay eligible for Sol.
- **Which set a run used.** Each sourcing run records the hash of the manifest it used (`resolved.manifestSha256`). The web page uses this hash to tell whether a run belongs to the hand-collected list or to one automatic search.
- **Invalidation.** New photos change the manifest hash and the image hashes, so earlier shortlists and comparisons are not treated as current. Saved shortlists use a candidate-set tag per discovery run.

## 11. Sol approval and verification

- **No automatic Sol.** Discovery and comparison never call Sol. The offline path has no paid client.
- **Dry run first.** `pnpm verify:visual --case <id> --candidates <discovery run folder> --dry-run` reports:
  - which candidates have usable photos;
  - which compatible records it will reuse;
  - how many paid requests are needed.
- **The paid step needs separate approval:** `--listing-id <id> --live --max-paid-requests 1`, or `--all --live --max-paid-requests <n>`. Its instructions, schema, duplicate protection and uncertain-outcome handling are unchanged.
- **Size of the first run.** A batch of 3–5 is enough for the first proof.

## 12. Web user journey

1. **Find similar products** (`/sourcing/find/<case>`). The automatic-search card says whether a source is available. When it isn't, a disabled button and the plain reason are shown, next to the existing hand-collection path.
2. **Search automatically** (`/sourcing/find/<case>/search`), shown only when eligible. It states:
   - the source and the fact that it is not Alibaba.com;
   - that only text is sent and never the photo;
   - charges and the cap, and the limits;
   - photo handling, and that supplier and price data are as the source reports them;
   - that the hand-collected list is untouched.

   **Confirm and search** sends one POST with a one-time request key; viewing the page sends nothing.
3. **Progress** is read from the saved records:
   - Searching products;
   - Reviewing returned listings;
   - Preparing product photographs;
   - Comparing available images;
   - Detailed verification;
   - Sourcing results ready.

   A failed search is shown as failed, never as zero results.
4. **Results.** Comparison results show "Potentially similar products — detailed verification pending." until Sol has run. The results say they were "found automatically through a web search index limited to Alibaba.com product pages". Products without photos are listed under "Photo needed".
5. **Advanced Workspace.** It keeps the run journal, queries, request ids, rejections, image outcomes and costs on disk, plus the orchestrator's provenance (`providerAccess: external_search_index`).

## 13. Live-test procedure (human-run, after authorization)

1. **Make the policy decision** in `AGENTS.md` and `POLICY_ALLOWED_ACQUISITION` (section 15). This is a person's decision; the code never makes it.
2. **Add the key:** `EXA_API_KEY` in `apps/web/.env.local`.
3. **Create `evals/local/marketplace-access.json`:**

   ```json
   {
     "schemaVersion": 1,
     "providers": {
       "exa-alibaba-index": {
         "accessBasis": "search_index_terms_review",
         "agreementReference": "<where your review of Exa's and Alibaba.com's terms is kept>",
         "reviewedBy": "<you>",
         "reviewedAt": "2026-11-03",
         "permittedModes": ["keyword"],
         "imageTransferApproved": false,
         "liveEnabled": true,
         "maxResultsPerRun": 20,
         "maxCostUsdPerRun": 0.25,
         "productImageRetrievalApproved": false,
         "retainRawResponses": false
       }
     }
   }
   ```

   Set `productImageRetrievalApproved` only once image rights are established.
4. **Check the plan:** `pnpm discover:products --case upl-2026-10-27t11-41-34z-a4adb99c`. Every check must say `ok`.
5. **Run the search:** `pnpm discover:products --case upl-2026-10-27t11-41-34z-a4adb99c --live --confirm-paid-search`, or use **Search automatically** in the web app.
6. **Read the results:** `pnpm discover:products --case … --status`, then validate with `pnpm source:candidates --candidates evals/local/discovery/<case>/<disc-id> --case … --validate`.
7. **Run SigLIP:** use **Compare these products** in the web app, or `pnpm source:auto --case … --source provider-run --discovery-run evals/local/discovery/<case>/<disc-id> --run --offline`.
8. **Run Sol, separately:** `pnpm verify:visual --case … --candidates evals/local/discovery/<case>/<disc-id> --dry-run`. Then pick 3–5 listings from the SigLIP order, not only the top one: on Ettrick, the strongest Sol design was SigLIP's 4th. Run them with `--listing-id <id> --live --max-paid-requests 1` per listing (see `pnpm verify:visual --help`).
9. **Final result:** run `source:auto` again to fold in the Sol records, then view the result in the web app.

## 14. Measured results

None. No live Exa request has been made; the search is blocked by policy and no key is configured. All counts in the tests come from synthetic responses. Report the real counts from the first authorized run's `import-summary.json`:

- results returned;
- Alibaba product links;
- furniture listings;
- unique products and duplicates;
- products with images, and images rejected;
- price and MOQ coverage, and supplier coverage (expected 0);
- cost.

## 15. Remaining blockers

1. **Project policy.** `AGENTS.md` allows only an official API or an approved partner, and Exa is neither. Allowing an external search index would mean changing `AGENTS.md` and adding `"external_search_index"` to `POLICY_ALLOWED_ACQUISITION`. That is a human decision. It is deliberately not exposed as a flag.
2. **Alibaba.com content rights.** Showing, storing and AI-processing listing data and supplier/price information have not been established.
3. **Image rights.** Downloading and caching alicdn.com product images has not been established. Without them, the visual pipeline cannot run on automatically found products: that outcome would be "LIVE PRODUCT DISCOVERY VERIFIED — VISUAL PIPELINE BLOCKED BY IMAGE EVIDENCE".
4. **Coverage.** Exa's index coverage of Alibaba.com is unknown until measured. Its prices are not live, and it reports no supplier data.
5. **No official route found.** No official Alibaba.com buyer-side search API and no licensed catalogue has been found (see P1-008).
