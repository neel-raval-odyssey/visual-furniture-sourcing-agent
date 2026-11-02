# Candidate acquisition for a newly analysed photo

How a photo analysed in the web app (P1-007) gets genuine marketplace candidates, and how those reach the existing shortlisting, verification and sourcing steps. Written for P1-008 on 2026-10-27.

**Status: IMPLEMENTED — AUTOMATED DISCOVERY AWAITING PROVIDER AUTHORIZATION.** Operator-assisted intake works in the web app and is tested offline. No genuine product has been recorded for a new photo yet, and no live marketplace search has been made.

## 1. The new-photo sourcing flow

```
uploaded photo → confirmed Luna analysis (P1-007) → saved reference (predictions + images.json)
   → /sourcing/find/<case>  "Ready to find similar products"
        automatic search: shown only if a source is eligible (none is today)
        Add product leads → 1. search Alibaba.com yourself  2. record products + photos  3. review, finish
   → evals/local/candidates/<case>.json + candidates/<case>/  (standard operator_assisted manifest)
   → "Compare with your photo": the existing offline run (SigLIP 2 locally, saved Sol records only)
   → /sourcing/results/<case>/<run>  "Products to compare — detailed comparison pending"
   → Sol verification: separate, paid, explicitly capped (pnpm verify:visual --live)
```

Both acquisition paths (provider and operator) end in the same `CandidateManifest`. Nothing downstream depends on which path produced it.

## 2. Marketplace-provider authorization

The decision and its evidence are in [marketplace-source-authorization.md](marketplace-source-authorization.md). The check is `discovery/authorization.ts`, `checkSourceEligibility`. It makes no network request and reports six separate checks:

| Check | Passes when |
|---|---|
| `implemented` | An adapter exists for the provider and mode |
| `policy` | The provider's acquisition method is an official API or a licensed partner (`AGENTS.md`). A scraper always fails. |
| `credentials` | The provider's environment variable is set |
| `access_record` | `evals/local/marketplace-access.json` (git-ignored, written by the developer) names the agreement, who reviewed it and when, and the permitted modes |
| `image_transfer` | Image and hybrid modes: the record approves sending reference photos to the provider |
| `live_enabled` | The record's live switch is on |

- **What the record is:** it documents a human review. It is not itself permission, and it can't override policy.
- **What is ignored:** tokens, Actor subscriptions and `--data-use-reviewed` are not checks.
- **Where it is applied:**
  - `discover:marketplace` calls the check before `--live`, `--resume` and `--fetch-images`, and fails closed with the blocking reason;
  - `--dry-run` prints every check;
  - live runs must also stay within the per-run caps recorded in the access record.
- **Today:** the only implemented provider (Apify Scrapewise) fails `policy`, so live discovery is blocked everywhere.

## 3. Automatic image-search readiness

The P1-004 path is reused unchanged for an uploaded reference:
- it loads the saved fingerprint and queries from `evals/local/predictions/<case>.json`;
- it resolves the photo through `images.json` (which points at the staged upload) and checks its hash;
- image mode is preferred, and image transfer needs its own explicit authorization;
- it reuses the existing client, caps, journal, resume, uncertain-start protection, normalization and image acquisition.

No second integration was written. In the web app, automatic search appears as a disabled control with the blocking reason. An enabled control would appear only for an eligible source, and none exists. Live runs would still go through `discover:marketplace` with their own flags.

## 4. Keyword-search fallback

Keyword mode uses the saved Luna `searchQueries` unchanged; instructions were not touched. In the operator path, the same queries are shown with copy buttons for the person to type into Alibaba.com.

## 5. Operator-assisted candidate intake

`/sourcing/find/<case>` (linked from the analysed upload page and the workspace reference page):

1. **Search:** the photo, the furniture type, the saved queries (copyable), and links to Alibaba.com and Alibaba Lens. The person searches with the site's own tools. The app automates no browser and fetches nothing.
2. **Record a product:**
   - required: the product link and title;
   - if shown: supplier name, supplier page link, lowest and highest price, currency, unit, minimum order and its unit;
   - how it was found, which suggested search was used, notes;
   - a product photo the person saved from the listing.
3. **Review:** each product can be edited (including replacing or removing its photo) or removed.
4. **Finish:** this publishes the list. Up to 20 products per list.

**Storage:** drafts live in `evals/local/candidate-intake/<case>/<intake id>/`:
- `session.json`, with an incrementing revision;
- `images/`;
- after completion, `manifest.json` (a copy) and `summary.json`.

**Writes:**
- every change runs under a cross-process lock and is saved by atomic rename;
- the session folder and file are created exclusively;
- reopening the page reopens the draft.

**Versions:** a saved list is never edited in place. To add photos, correct details or add products, start a revision (section 5a), which publishes a new version and keeps every earlier one.

## 5a. Revising a saved list (P1-008.1)

**Why it exists:** the first real intake saved three genuine products without photos. The comparison could then only produce empty cards, and the saved list couldn't be changed.

**On the find page:**

| Saved list | What the page offers |
|---|---|
| No product has a photo | "3 products saved · 0 ready to compare", "Add at least one product photo to compare its design with your furniture.", and **Add product photos**. No comparison is offered. |
| Some products have photos | **Compare available products**, with the counts ("2 products with a photo will be compared. 1 product without a photo will stay in the list, not compared.") and **Add missing product photos** |
| Every product has a photo | **Compare with your photo** |

The offline-run route also refuses a list with no photos (409), so an empty comparison can't be started some other way.

**A revision** (`ui/intake/revision.ts`) is a new draft pre-filled from the current saved list, in the same order and with the same ids, links, titles and fields; missing fields stay missing. Nothing is re-entered or fetched.
- **Photos:** each product has **Add photo** / **Replace photo**. Only the photo changes; it is validated like every product photo.
- **Corrections and additions:** **Edit** corrects optional details such as the supplier name and page. **Add another product** records one more, with duplicate detection and the 20-product limit.
- **Kept automatically:** manifest data the form doesn't edit (category, attributes, price tiers, extra images, supplier badges) is carried through unchanged.
- **Review:** before saving, the page lists what will change (photos added or replaced, products corrected, added or removed). **Save this version** publishes; **Discard this revision** closes the draft without changing anything.

**Versions and history:**
- **Starting a revision** writes an immutable snapshot of the exact list being revised to `candidate-intake/<case>/history/manifest-<sha256>.json`. Each published version also keeps its own copy (`<intake>/manifest.json` and `summary.json`, with `previousManifestSha256`).
- **Publishing a revision:**
  - takes the collection's lock;
  - refuses (`stale`) if the saved list is no longer exactly the one the revision started from;
  - publishes new photos under new names, while unchanged photos keep their published file and path;
  - writes a complete manifest next to the canonical one and validates it with the `source:candidates` checks and import;
  - then renames it into place atomically.

  A failure removes the new photos and the temporary file and leaves the saved list unchanged.
- **Only one draft per reference:** concurrent starts open the same draft. A second simultaneous publish of the same draft is refused.
- **Published photo files are never deleted or replaced,** so earlier runs (whose results and journals record their own photo hashes) stay readable.

**Effect on comparisons:**
- **Shortlists:** a saved SigLIP shortlist is reused only if every candidate's photo hash and path still match (existing check). After photos change, the next comparison recomputes with the new photos.
- **Sol assessments** for a changed photo are reported as stale by the existing verification records.
- **Which run counts as current:** the find page treats a run as current only if its journal's manifest hash equals the current list. Older runs are offered as "earlier results".

**Labels for products that haven't been assessed:**

| Label | Meaning |
|---|---|
| Product saved | Recorded in the list |
| Photo needed | No usable photo |
| Ready to compare | Has a photo, not yet compared |
| Compared locally | Ranked by the local quick comparison; detailed verification pending |

- **The results page for a run where nothing could be compared** reads "Saved product leads — None of these products has been compared with your photo yet", with an **Add product photos** link. It is not "potentially similar".
- **The Ettrick verified results are unchanged.**

## 6. Product and supplier normalization

- **Links:** listing and supplier URLs pass the existing `checkMarketplaceUrl` rules:
  - https only, no credentials or ports;
  - an alibaba.com host or a true subdomain, so lookalikes, 1688.com and other schemes are refused.
- **Duplicates:** the product id is read from the URL, and duplicates are detected with the existing `candidateIdentity`.
- **Absent stays absent:** a missing price, MOQ or supplier stays missing; nothing is defaulted. The currency is upper-cased; a highest price needs a lowest price, and an MOQ must be a whole number.
- **Suppliers:** merged by profile URL, otherwise by exact (case-insensitive) name. Two products from one supplier share one supplier record.
- **Provenance:** `method: "operator_assisted"`, the tools used, the queries used, a capture time per product, and a note naming the intake id. No provider fields.

## 7. Image handling

- **Checks:** product photos are checked like uploads: 10 MB or less, real PNG, JPEG or WebP format from the bytes, structure and dimensions. They are stored under generated names with exclusive writes, and the original filename is kept for display only.
- **Hashes:** each photo's SHA-256 is recorded.
- **Display:** photos are shown through the existing evidence route, as `intake/<case>/<intake>/<product>` (confined, symlinks refused, hash-checked, `private, no-store`).
- **On completion:** each photo is re-verified, then hard-linked (or copied when linking isn't possible; never overwriting) to `candidates/<case>/<intake>-<product>.<ext>`.
- **Nothing is downloaded.** A product without a photo stays in the list, marked "No photo: can't be compared".

## 8. Candidate-manifest compatibility

- **On completion:** the manifest is built and validated with `candidateManifestSchema`, written exclusively to `evals/local/candidates/<case>.json`, and then checked with the same `loadManifest` / `checkManifest` / `importCuratedCandidates` that `pnpm source:candidates` uses (case, reference, fingerprint and local files).
- **If any step fails,** everything this completion published is removed and the list stays a draft.
- **Readers:** `source:candidates`, `shortlist:images`, `verify:visual` and `source:auto --source curated` read this location. The web offline run became eligible for the reference with no orchestrator change.

## 9. SigLIP integration

The existing shortlist stage is used unchanged:
- the reference photo comes through its mapping, with a hash check;
- candidate photos come through the manifest, with confinement and hashes;
- a compatible saved shortlist is reused, otherwise embeddings are computed locally only when the checkpoint is cached (`HF_HUB_OFFLINE=1`, `local_files_only=True`);
- if it isn't cached, the stage is `blocked` with "nothing is downloaded automatically", and no scores appear.

**Recall:** no top-k or cosine threshold is applied. Every product with a photo is ranked (`selection: all`), and products without one stay listed as unscored. Retrieval order and verification order stay separate.

## 10. Offline orchestration

"Compare with your photo" calls the existing `startOfflineRun` (P1-005). The result is `partial`:
- products with photos have a quick-comparison (retrieval) rank, and no design index or classification;
- products without photos are `no_image`;
- supplier names and listing links are carried through.

The simple results page shows "Products to compare — Potentially similar products — detailed comparison pending", in retrieval order, each "Not yet compared". The Ettrick example (which has verified results) is unchanged.

## 11. Sol verification handoff

No Sol request is made by intake, shortlisting or the offline run. The verification stage reports how many new paid requests would be needed. To verify, run, separately and with explicit caps:

```sh
pnpm verify:visual --case <case> --dry-run      # plan, no request
pnpm verify:visual --case <case> --live --all --max-paid-requests <n>   # paid; only after you decide to
```

After that, an offline run reuses the saved assessments, and the existing ranking and comparison screens apply.

## 12. Missing data and failures

| Situation | Behaviour |
|---|---|
| Missing price, MOQ or supplier | Stays missing; shown as "not recorded" |
| Missing photo | Listed, not compared |
| Invalid URL, duplicate product, bad photo | Refused with a message next to the field |
| Existing collection | Completion refused; nothing published |
| Photo changed after recording | Completion refused until it is replaced |
| No cached checkpoint | Shortlist stage blocked; no scores |
| Unreadable session | Not listed; no changes accepted |

## 13. Cost and privacy controls

- **No paid request** (OpenAI) and **no external request** (Alibaba, Apify, image hosts) is made by intake, the find page, the offline run, or any page render.
- **Everything stays local:** all files live under the git-ignored `evals/local/`.
- **Routes:** the intake route uses the local-only guard (opt-in flag, never in production, loopback host, same-origin POST). It accepts only form fields and one image; no paths.
- **Provider caps:** live provider runs are limited by the existing CLI caps and by the access record's per-run caps.

## 14. Exact test commands

```sh
pnpm test                                    # everything; P1-008 adds:
#   apps/web/src/lib/sourcing/discovery/authorization.test.ts
#   apps/web/src/lib/sourcing/ui/intake/intake.test.tsx       (intake, completion, offline run, route, genuine reference read-only)
#   apps/web/src/components/sourcing/intake/find-view.test.tsx
#   apps/web/src/lib/sourcing/cli/discover-marketplace.test.ts (real gate blocks live; dry run reports it)
pnpm --filter web exec vitest run src/lib/sourcing/ui/intake src/lib/sourcing/discovery/authorization.test.ts src/components/sourcing/intake
pnpm discover:marketplace --case upl-2026-10-27t11-41-34z-a4adb99c --provider apify --mode image --dry-run   # shows BLOCKED checks; sends nothing
pnpm source:candidates --case <case> --validate       # after completing an intake or saving a revision
pnpm shortlist:images --case <case> --dry-run
pnpm verify:visual --case <case> --dry-run
pnpm source:auto --case <case> --source curated --plan
```

## 15. Remaining blockers

- **No authorized automated source.** No official Alibaba.com buyer-search API was found, and no licensed partner was identified. The implemented Apify scraper is blocked by policy.
- **Revisions are linear:** one draft at a time, based on the current list. There is no view or restore of older versions in the UI yet; the snapshots are files in `candidate-intake/<case>/history/`.
- **Detailed comparison is paid** and runs from the CLI, with explicit caps; there is no web control for it.
- **Operator effort:** each product takes a few minutes, by design.
