# Visual sourcing web experience

The first usable interface for the Visual Furniture Sourcing Agent: a local Next.js workspace over the real saved sourcing records. Written for P1-006 on 2026-10-27; simple view added in P1-006.1 (same day).

**Scope.** This is a local development experience over saved evidence. It does not run live marketplace discovery or paid model inference, and it is not a deployable multi-user application.

## 1. User flow

Two layers over the same saved records and services.

**Simple view (default, for buyers, designers and presentations):**

```
/sourcing  "Find furniture that looks like this." + the saved example photo
  ├─ Explore example results ─→ /sourcing/results/<case>/<run>                       closest design, other designs, not-yet-compared
  │                                └─ Compare designs ─→ …/compare/<listing id>        both photos, verdict, similar / different
  └─ Upload your own photo ───→ /sourcing/uploads/<upload id>                        "Photo saved successfully. Image analysis is the next step."
```

**Advanced workspace (for developers and researchers),** linked discreetly in the header and footer:

```
/sourcing/workspace ─ references (photo, readiness) ─┬─ /sourcing/references/<case>        fingerprint, runs, "Run using saved evidence"
                     upload a photo ─────────────────┤    └─ /sourcing/references/<case>/runs/<run>        results + recorded stage progress
                                                     │          └─ …/candidates/<listing id>                 side-by-side comparison + evidence
                                                     └─ /sourcing/uploads/<upload id>
```

All P1-006 deep links under `/sourcing/references/…` are unchanged.

## 2. Routes and components

**Pages** (`apps/web/src/app/sourcing/`, all server components):

| Page | Purpose |
|---|---|
| `page.tsx` | Simple start screen: the promise, the saved example photo, "Explore example results", and photo upload |
| `results/[caseId]/[runId]/page.tsx` | Simple results: closest design, other designs, not-yet-compared products, technical details collapsed |
| `results/[caseId]/[runId]/compare/[listingId]/page.tsx` | Compare designs: both photos, verdict, most important difference, similar / different, detail behind disclosures |
| `workspace/page.tsx` | Advanced workspace: references with readiness, provider status, upload, and staged uploads |
| `references/[caseId]/page.tsx` | The saved Luna fingerprint (structure, appearance and distinctive features, each labelled with its certainty), runs, next action |
| `references/[caseId]/runs/[runId]/page.tsx` | Results: overview counts; the closest verified design next to the reference; verified candidates in Sol order (with an optional SigLIP retrieval order via `?sort=retrieval`); unverified candidates listed separately; the recorded stage timeline; warnings, follow-ups and model provenance |
| `…/candidates/[listingId]/page.tsx` | Comparison: reference and candidate photos (full-size view, no overlays), grouped Sol evidence, product and supplier facts |
| `uploads/[uploadId]/page.tsx` | A staged upload and its analysis: ready, confirming, analyzing, analyzed (plain-English furniture summary), not identified, failed or uncertain |
| `layout.tsx` | The shell and the local-access explanation |

**API routes** (`apps/web/src/app/api/sourcing/`, Node runtime):

| Method and route | Purpose |
|---|---|
| `GET evidence/[...parts]` | Private images by evidence id |
| `POST uploads` | Stage a photo |
| `GET`/`POST uploads/[uploadId]/analysis` | Analysis status (read-only); one confirmed GPT-6 Luna analysis, or finishing an already-paid save |
| `POST runs` | Offline run from saved evidence |
| `GET runs/[caseId]/[runId]` | Stage states, for bounded polling |

**Components** (`apps/web/src/components/sourcing/`):

| Component | Role |
|---|---|
| `primitives.tsx` | Icons (inline SVG), badges (icon, text and colour, never colour alone), notices, links, data rows |
| `evidence-image.tsx` | Client component: loading and error states, full-size dialog |
| `candidate-card.tsx` | One candidate card |
| `evidence-sections.tsx` | Evidence groups, including partial structural differences |
| `product-details.tsx` | Marketplace-reported facts, with optional details collapsible |
| `stage-timeline.tsx` | The recorded stage states |
| `run-offline-button.tsx` | Client component |
| `upload-dropzone.tsx` | Client component |
| `run-refresher.tsx` | Client component: bounded polling |
| `simple/start.tsx`, `simple/results.tsx`, `simple/compare.tsx` | The three simple screens, as data-in views (the pages only load records) |
| `simple/parts.tsx` | Product card, difference note, disclosure, buttons, the saved-example note |

**Styling:** Tailwind v4 theme tokens in `src/app/globals.css` (ivory, graphite and walnut accent, with status colours) and system font stacks (a serif for headings). No UI or icon library was added, and no web fonts are fetched.

## 3. Data access

`apps/web/src/lib/sourcing/ui/` is server-only and reuses the existing validators:

| Module | Contents |
|---|---|
| `data.ts` | Lists references (saved Luna runs, plus any case with sourcing runs), runs (`run.json` via `loadRunJournal`, with stale `running` journals marked interrupted) and run detail (`result.json` via the new boundary validator `orchestration/result-schema.ts`) |
| `evidence.ts` | Evidence ids → bytes (section 6) |
| `uploads.ts` | Upload staging (section 7) |
| `offline-run.ts` | The P1-005 orchestrator (section 8) |
| `labels.ts` | Presentation vocabulary |
| `simple.ts` | Simple-view models: featured example, plain verdicts, similarities and differences, short titles, balanced grids |
| `local-access.ts`, `page-gate.ts` | The local-only guard |

Pages receive presentation data only: no local paths, raw model payloads or credentials. There is no second source of truth: every view is derived from `result.json` and `run.json`.

## 4. Local setup

```sh
pnpm install
pnpm dev:local          # VFSA_LOCAL_SOURCING_UI=1 next dev -H 127.0.0.1
# open http://localhost:3000/sourcing
```

- **Opt-in flag:** `VFSA_LOCAL_SOURCING_UI=1` is required. Without it, pages show an explanation and the API routes return 403.
- **Repository root:** found automatically (the folder with `pnpm-workspace.yaml`). Override with `VFSA_REPO_ROOT`.
- **No API keys are needed.**
- **`agentRules: false`** in `next.config.ts` stops `next dev` from writing an `apps/web/AGENTS.md`; the project's agent rules stay in the root `AGENTS.md`.

## 5. How runs are found

- **Runs:** `evals/local/sourcing-runs/<case>/<run id>/`, where the run id must match `src-<timestamp>-<hex>` and the case a lower-case slug.
- **Routes:** resolved from those identifiers only, never from a path.
- **Bad records:** invalid journals or results appear as "Unreadable record", with the validation message.

## 6. Local image serving

`GET /api/sourcing/evidence/…` takes an evidence id, never a path:

| Evidence id | Image |
|---|---|
| `reference/<case>` | The reference photo found through `images.json`; served only if its SHA-256 equals the saved Luna run's hash |
| `candidate/<case>/<run>/<listing>` | The image recorded for that listing in that run's `result.json`, resolved from the run journal's own source (curated manifest or discovery run folder) |
| `upload/<upload id>` | A staged upload |

**Each file must:**
- be inside its approved folder (`evals/local/candidates`, `evals/local/discovery` or `evals/discovery`, under `<case>/`), with symlinks and escapes refused;
- be a regular file of at most 15 MB;
- still match the SHA-256 recorded for it (otherwise 409);
- be PNG, JPEG or WebP, checked from the bytes.

**Responses:**
- headers `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`;
- errors are JSON without local paths.

**Local-only access** (`local-access.ts`):
- the flag above, and never when `NODE_ENV=production`;
- loopback `Host` only (`localhost`, `127.0.0.1`, `[::1]`), which also blocks DNS rebinding;
- mutations also require a same-origin loopback `Origin`, so no cross-site form posts;
- pages apply the same gate before reading any record.

Bind the dev server to loopback (`pnpm dev:local` does).

## 7. Upload staging

`POST /api/sourcing/uploads` (multipart, field `file`):
- **Checks:** at most 10 MB; the real format from its signature (PNG, JPEG or WebP); structure and dimensions via `image-input/inspect.ts`. Corrupt or unsupported files return 422 with a message.
- **Storage:**
  - `evals/local/uploads/<upl-…>/image.<ext>` plus `upload.json` (id, time, SHA-256, type, size, sanitized original name used for display only);
  - a fresh id and folder each time, with exclusive writes, so nothing is ever overwritten.
- **What it doesn't do:** send anything anywhere, run Luna, or search.

The upload page says **"Photo saved successfully"** and offers **Analyze this photo**: one explicitly confirmed GPT-6 Luna request that turns the photo into a saved reference (P1-007, see [new-photo-image-understanding.md](new-photo-image-understanding.md)). `upload.json` itself is never changed; its `awaiting_image_understanding` status is the staging status, and the analysis state lives in the upload's attempt journal. AVIF is not accepted for upload: the local conversion path lives in `services/vision` and is used only for discovered listing images.

## 8. Offline sourcing from the UI

**"Run using saved evidence"** sends `POST /api/sourcing/runs` with `{caseId, mode: "offline-saved-evidence"}`. It then calls the P1-005 `runOrchestration` directly, over the case's curated manifest; there is no CLI and no shell.

- **What it reuses:** compatible SigLIP shortlists and Sol records. It may run SigLIP 2 locally with an already-cached checkpoint; nothing is downloaded.
- **What it never does:** marketplace, image-download or paid requests. The orchestrator has no such capability.
- **One run at a time:** one run per case. The case is reserved before any asynchronous work, so simultaneous clicks are refused (409).
- **History:** earlier runs are kept, and each run has a new id.
- **Honest progress:** the button's pending state lasts exactly as long as the request.

The run page polls `GET /api/sourcing/runs/<case>/<run>` only while the journal says `running`: every 2 s, at most 90 times, stopping at a terminal state. There is no queue or worker.

## 9. How saved model evidence is shown

**Sol evidence** comes from `result.json` (which itself comes from saved records), grouped as:
- matching features;
- **partial structural differences** (for example Ettrick candidate 001's six arches versus seven), kept as their own group rather than folded into the matches;
- structural mismatches;
- appearance differences;
- visibility limitations;
- uncertain claims.

**Labels and links:**
- The design index, classification and confidence are each explained next to the score.
- "High confidence" is about the visual assessment, not supplier reliability.
- SigLIP rank and cosine appear in a separate, labelled "retrieval signal".

## 10. Verified versus unverified

- **Verified** candidates are ordered by the Sol index, ties by listing id, exactly as recorded.
- **Unverified** candidates (no image, missing, stale, failed or ambiguous assessment) are listed separately as "Not visually verified", with the reason and no score.
- **Retrieval order:** the optional SigLIP order lists every candidate, and the default verification order is one click away.
- **No hidden ranking factors:** price and supplier data never affect any order.

## 11. Marketplace-provider limitations

The workspace states: "Automated marketplace discovery is awaiting authorized provider access."
- **No live search button:** the Apify integration (P1-004) is not exposed.
- **What saved discovery runs can show:** only what they recorded. Remote-only images remain "cannot be visually compared".

## 12. No automatic charges

**No route can:**
- call GPT-6.1 Sol;
- start provider discovery;
- download marketplace images.

**One exception, explicitly confirmed:** `POST /api/sourcing/uploads/<id>/analysis` with `{"action":"analyze","attemptKey":…}` sends one GPT-6 Luna request for one staged photo, after the user confirms a dialog that explains the charge. It is reserved durably, never retried and never repeated automatically ([new-photo-image-understanding.md](new-photo-image-understanding.md)).

**Also guaranteed:**
- **Rendering is read-only:** page rendering only reads files, and never runs a model; the analysis status endpoint is read-only too.
- **Keys are not permission:** the presence of `OPENAI_API_KEY` or `APIFY_TOKEN` never starts anything. Tests stub both, and assert that `fetch` is never called.

## 13. Testing and QA

**Automated tests** (Vitest; `.tsx` tests are now included, plus an `@` alias):

| File | Covers |
|---|---|
| `ui/data.test.ts` | Readiness, a validated run, partial verification, a missing photo, invalid results and journals, stale runs |
| `ui/routes.test.ts` | Evidence (valid, traversal, unknown ids, symlink, changed, missing, oversized, unsupported, disabled, production, non-loopback); uploads (valid, unique ids, wrong type, corrupt, oversized, cross-origin); offline run (orchestrator reuse, prior runs kept, duplicate concurrent submissions, unsupported modes, not eligible) |
| `components/sourcing/components.test.tsx` | Server rendering of cards (verified and unverified), evidence groups with partial differences, marketplace-claim wording, the stage vocabulary, the upload pre-check |
| `components/sourcing/simple/simple.test.tsx` | The simple view (section 13a) |

**Manual QA:**
- headless Chrome against `pnpm dev:local`, with DevTools-protocol mobile emulation;
- widths 1440, 768 and 390 px;
- no horizontal overflow measured on any page.

## 13a. The simple view

**Purpose:** someone who knows nothing about AI should understand the product in seconds: one promise, the saved example photo, one main action.

**What it shows, all from the saved `result.json` (nothing hard-coded):**
- **Featured example:** the genuine reference whose latest readable run compared the most products (`getFeaturedExample`); synthetic cases only if no genuine one exists, and then labelled.
- **Order:** the recorded verification order. The first verified product is "Closest design found"; the others follow in a grid sized to stay balanced (3 → one row, 4 → 2×2). Products without an assessment are listed separately as "Not yet compared", with the reason and no score.
- **Plain verdicts:** `exact_visual_design` → "Very close design" (with "not the same product or maker"), `close_variant` → "Close design", `similar_alternative` → "Similar alternative", `non_match` → "Different design", `insufficient_evidence` → "Not enough detail", no assessment → "Not yet compared". Nothing says "exact match", "identical", "same manufacturer" or "verified supplier".
- **Why it looks similar / what's different:** recorded evidence items, quoted as written. Similarities: structure before finish, defining before supporting. Differences: structural before colour or finish, then by importance, partial before mismatch. So Ettrick candidate 001 leads with "Headboard arch arrangement — Original: seven… This design: six…".
- **Short titles:** the marketplace title up to "with"/"for"/a comma, cut at a word boundary; the full title stays in a tooltip and in the product details.
- **Price and minimum order:** one secondary line, always "as listed".

**Hidden by default, one click away:** design index, classification and confidence wording, SigLIP rank and cosine, model and instruction versions, run id (results page: "Technical details"; compare page: "See detailed comparison", which also holds the full grouped evidence, and "Product and supplier details"). Each links to the matching advanced-workspace page.

**Honesty notes:** "This example uses saved Alibaba listings. Live marketplace search is not yet available." sits beside the main action and in the results header. Uploading is described as saving the photo for later analysis; there is no "Find suppliers" action for uploads.

**Tests** (`components/sourcing/simple/simple.test.tsx`): the start screen features the saved reference and links to its run; truthful empty states; results in saved order with no technical terms, scores or "exact" in the undisclosed content; the arch difference shown; unverified products unscored; detailed evidence and Alibaba links present; no request made by rendering. A read-only check against the genuine Ettrick records runs when they exist locally.

## 14. Current limitations

- **Local and single-user only:** no authentication.
- **No end-to-end flow for new photos:** an upload can be analysed into a saved reference (one confirmed Luna request), but it gets no candidates until authorized discovery or a curated manifest exists.
- **Curated candidates only:** offline runs from the UI use the curated candidate set; saved provider runs are viewable when they exist, but are run via `pnpm source:auto`.
- **Same-process lock:** the offline-run lock is per server process, backed by the journal's `running` state.
- **Long runs block the request:** a run that must recompute SigLIP keeps its request open while it does so.

## 15. Before any production deployment

1. Add authentication and per-user authorization.
2. Move private evidence to access-controlled storage with signed URLs.
3. Replace the local-only guard with real access control, plus CSRF tokens.
4. Run jobs out of process, with a durable lock.
5. Add audit logging.
6. Obtain explicit approval for paid steps (Luna, Sol) and authorized marketplace access, each with its own budget.
