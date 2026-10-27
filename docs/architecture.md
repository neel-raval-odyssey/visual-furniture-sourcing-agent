# Architecture

Design of the sourcing system. Implemented: image understanding (GPT-6 Luna), operator-assisted and provider-based candidate intake, SigLIP 2 shortlisting, GPT-6.1 Sol verification and offline orchestration (`pnpm source:auto`). A local web interface (`pnpm dev:local`) presents saved results: a plain-language simple view and an advanced workspace. It can also analyse a newly uploaded photo into a saved reference with one confirmed GPT-6 Luna request. Not yet available: authorized live marketplace acquisition, a production ranking policy, and a deployable multi-user application.

## Pipeline

```
reference photo
   │
   ▼
1. Image understanding ──► structured attributes + search queries
   │
   ▼
2. Candidate discovery ──► candidate Alibaba listings (via adapter)
   │
   ▼
3. Visual comparison ────► embedding shortlist ──► detailed comparison
   │
   ▼
4. Seller intelligence ──► seller attributes per candidate
   │
   ▼
5. Results ──────────────► ranked products with explanations
```

### 1. Image understanding

- Input: a user-supplied photo (product shot, room photo, screenshot, social post).
- Model: **GPT-6 Luna** (implemented; see [Real image understanding](#real-image-understanding-gpt-6-luna)).
- Output: furniture category, key visual attributes (silhouette, materials, colour, legs/base, upholstery, proportions), style tags, and several search queries. If the photo contains several items, identify the target item (possibly with a crop).

### 2. Candidate discovery

- An `AlibabaDiscoveryAdapter` interface isolates the source. Implementations will only use a **confirmed, authorized integration** (official API or approved partner). No scraping.
- `MockAlibabaDiscoveryAdapter` (fixture-backed, no network) backs development and tests. See [Code structure](#code-structure).
- Output: normalized candidate records (listing ID, title, images, price range, MOQ, seller reference, source URL).

### 3. Visual comparison

Two stages, to keep cost bounded:

1. **Embedding similarity** — SigLIP 2 image embeddings for the reference image and candidate images, computed locally by `services/vision` (PyTorch + Hugging Face Transformers). Cosine similarity ranks candidates and produces a shortlist. Implemented with **SigLIP 2 Base Patch16-384** by default; So400m Patch14-384 is selectable. See [visual-shortlisting.md](visual-shortlisting.md).
2. **Detailed comparison** — **GPT-6.1 Sol** compares the reference with each candidate photo, one pair per request, and returns structured evidence mapped to `VisualMatchAssessment` (classification, design similarity index, confidence, matching and differing features). Implemented; awaiting its first live run. See [visual-verification.md](visual-verification.md).

### 4. Seller intelligence

- Attach seller data available through the authorized integration: years on platform, verification status, ratings, response rate, location, trade assurance.
- Used as a secondary ranking signal and displayed to the user; it never overrides design similarity on its own.

### 5. Results

- Final ranking combines detailed-comparison verdict, embedding similarity and seller signals.
- Each result shows images, price/MOQ, seller summary, and a short explanation of similarities and differences.

## Code structure

Shared TypeScript contracts live in `apps/web/src/lib/sourcing/`:

- `domain/`: JSON-serializable, type-only models with no SDK or Next.js dependencies.
  - `ReferenceImage`: a photograph from any source. Its origin is independent of the marketplace.
  - `FurnitureFingerprint`: each feature is tagged `observed`, `inferred` or `unknown`.
  - `CandidateListing`, `SupplierProfile`: optional fields stay absent when unknown. Absent never means negative.
  - `VisualMatchAssessment`: `designSimilarityIndex` (0–100, not a calibrated probability) is separate from `confidence` (`low | medium | high`). Classifications describe visual design only, not manufacturer or SKU identity.
  - `RankedSourcingResult`: assessment, supplier and rank are optional, so discovery output can be represented before matching runs.
- `discovery/`: the `AlibabaDiscoveryAdapter` interface (`discoverCandidates(request) → result`). Discovery returns candidates, suppliers and provenance only. It never scores similarity or ranks results.
- `discovery/providers/apify/`: `ApifyAlibabaDiscoveryAdapter` (provider `apify-alibaba-discovery`), automated discovery through the Apify Actor `scrapewise/alibaba-com-scraper`, a third-party scraper and not an official Alibaba.com API. Capped runs per search mode, a `run.json` journal for resume and replay, strict row validation, and normalization into a `provider_api` candidate manifest that the curated importer reads. `discovery/images/` caches provider image URLs under strict network rules. See [automated-marketplace-discovery.md](automated-marketplace-discovery.md).
- `discovery/curated/`: `CuratedAlibabaDiscoveryAdapter` imports operator-recorded Alibaba.com candidates from a validated private manifest. See [alibaba-candidate-intake.md](alibaba-candidate-intake.md).
  - It performs no search and no network request.
  - Provider `curated-alibaba`, `acquisitionMethod: "operator_assisted"`, `queriesUsed: []`.
  - Genuine records must use real Alibaba.com hosts; synthetic ones must use reserved example domains.
- `understanding/saved/`: `SavedFingerprintImageUnderstandingService` replays a fingerprint from a saved `analyze:image` run record, so a reference can be reused without another model call.
- `verification/UnassessedVisualVerificationService`: returns no assessments, so real candidates stay "not assessed" until detailed visual verification exists.
- `verification/openai/`: `OpenAIVisualVerificationService` (GPT-6.1 Sol), implementing `VisualVerificationService`. Pairwise requests with only the two images and the fingerprint's visual observations; strict raw schema, consistency checks and adapter-owned provenance; a `PaidRequestBudget`; private run records and an offline report. `pipeline/verified.ts` composes it with the curated path. See [visual-verification.md](visual-verification.md).
- `ui/` and `apps/web/src/app/sourcing/`: the local web interface. `ui/simple.ts` holds the plain-language view models for the simple view (selection and wording only; scores and order unchanged); the advanced workspace lives under `/sourcing/workspace` and `/sourcing/references/…`. `ui/analysis/` turns a staged upload into a reference: preflight (hash, format, dimensions), a durable attempt journal reserved before one confirmed Luna request through `OpenAIImageUnderstandingService`, the standard run record in `evals/local/predictions/`, and a locked, atomic `images.json` entry pointing at the staged photo (see [new-photo-image-understanding.md](new-photo-image-understanding.md)). Server-only data access over the saved records (`result.json` validated by `orchestration/result-schema.ts`), a hash-checked evidence-image route that resolves ids through records rather than paths, private upload staging, and offline runs through `runOrchestration`. Local-only guard: an opt-in flag, never in production, loopback Host, and a same-origin check on mutations. See [visual-sourcing-web-experience.md](visual-sourcing-web-experience.md).
- `orchestration/`: `runOrchestration` composes the saved fingerprint, a candidate source (curated manifest or saved discovery run), image-evidence checks, SigLIP 2 shortlist reuse or local computation, and saved Sol records into one `sourcing_result` (`pnpm source:auto`). Resumable journal, input identity, explicit verification-selection policy, ordering by the Sol index only. It makes no external or paid request. See [automated-sourcing-orchestration.md](automated-sourcing-orchestration.md).
- `shortlisting/`: retrieval-stage visual shortlist (`pnpm shortlist:images`). See [visual-shortlisting.md](visual-shortlisting.md).
  - `evidence.ts` resolves the reference photograph (hash-checked against the saved run) and each listing's local images (confined to `<candidates>/<case>/`).
  - `embedding-client.ts` runs `python -m vfsa_vision embed` as a child process with a JSON protocol (`protocol.ts`, strictly validated and cross-checked against the request).
  - `shortlist.ts` builds a `VisualShortlist`: listings ranked by `embeddingCosineSimilarity`, with listing and supplier identity, image provenance, exclusions with reasons, and `visualVerificationStatus: "not_assessed"`. It never produces `VisualMatchAssessment` fields and is not part of `SourcingPipeline`.
- `discovery/mock/`: `MockAlibabaDiscoveryAdapter` and synthetic fixtures (example.com URLs, `[MOCK]` titles, `dataSource: "mock"`). It applies simple category and text filters, keeps fixture order and makes no network requests.
- `understanding/`: `ImageUnderstandingService.analyze(reference) → FurnitureFingerprint`. The mock looks up hand-written fingerprints by reference id. It doesn't read pixels, and it throws `UnsupportedReferenceError` instead of inventing a fingerprint. `understanding/openai/` holds the real implementation (below).
- `evaluation/`: offline evaluation of image understanding. It has no API calls and doesn't load the OpenAI SDK.
  - Zod schemas for the dataset, run records and human reviews.
  - A deterministic metrics engine, plus JSON and Markdown reports.
  - `analyze:image --output` writes a run record with the fingerprint, or a typed `not_identified` / `error` result, plus settings, usage, duration and image SHA-256.
  - `FurnitureNotIdentifiedError` and `VisionModelError` now optionally carry `response` (id, reported model, usage), so a rejection's tokens and trace aren't lost.
- `image-input/`: `ReferenceImageContentProvider` resolves a reference's bytes (JPEG, PNG or WebP, at most 10 MB, format checked by file signature). It's independent of the model client. The local CLI uses a file reader and an in-memory provider; uploads and storage will plug in here later.
- `verification/`: `VisualVerificationService.verify({ reference, fingerprint, listings }) → VisualMatchAssessment[]`.
  - It assesses only the listings it is given, at most one assessment per listing. It never searches, enriches suppliers or ranks.
  - The mock returns predefined assessments marked `metadata.method: "fixture"`. Their similarity values are arbitrary examples, not model output or measurements.
- `ranking/`: `SourcingRankingService.rank({ listings, suppliers, assessments }) → RankedSourcingResult[]`.
  - `ProvisionalRankingService` is a placeholder policy for testing orchestration only. Order is by classification (exact, close, similar, insufficient evidence, non-match, unassessed), then similarity (null last), then listing id. There are no weights and no calibration.
- `pipeline/`: `SourcingPipeline`, the orchestrator.
- `validation/`: Zod 4 runtime schemas that mirror the domain contracts.
  - Each schema has a compile-time `SchemaMatches` check against its interface, so `pnpm typecheck` fails if the two drift apart.
  - Objects are strict: unknown keys are rejected, not stripped. The only open-ended field is `CandidateListing.attributes`, a string record that keeps every key.
  - Nothing is coerced or defaulted, so missing optional data stays missing.

### Sourcing pipeline

```
ReferenceImage
  → ImageUnderstandingService.analyze        (stage: image_understanding)
  → AlibabaDiscoveryAdapter.discoverCandidates (stage: candidate_discovery)
  → VisualVerificationService.verify          (stage: visual_verification; skipped when there are no candidates)
  → SourcingRankingService.rank               (stage: ranking)
  → SourcingPipelineResult { reference, fingerprint, discovery, assessments, results }
```

- **Dependency injection:** the four services are passed to the constructor as plain interfaces. There's no DI framework. `createSyntheticSourcingPipeline()` wires up the mocks; real integrations will be passed in the same way.
- **Validation between stages** has two layers, in this order:
  1. *Structural:* each stage's raw output is parsed with its schema (fingerprint, discovery result, assessment array, ranked-result array). This catches wrong types, missing fields, invalid enums, similarity outside 0–100 and malformed timestamps or URLs.
  2. *Integrity:* checks that the data belongs to this run:
     - The fingerprint must reference the input image.
     - Discovery must not return duplicate listing or supplier ids.
     - Each assessment must refer to a discovered listing, at most once, for the current reference and fingerprint, with similarity in 0–100 or null.
     - Ranking must return every listing exactly once, with ranks 1..n and correct supplier and assessment links.
- **Errors:** any stage failure or contract violation is raised as `SourcingPipelineError` with `stage` and the original `cause`; for schema failures the cause is the `ZodError`. The message lists field paths and issue codes only, never payload values. Failures are never replaced with fabricated data.
- **Empty discovery is not an error.** The run returns empty assessments and results.
- **Provenance** records two separate things, both typed: the *data source* (`DataSourceKind`: `mock` or `live`) and the *method or provider*:
  - Fingerprints: `source.dataSource` + `source.kind` / `modelId`.
  - Discovery: `provider.dataSource` + `providerId`.
  - Listings and suppliers: `provenance.dataSource` + `marketplace`.
  - Assessments: required `metadata.dataSource` + `method` / `modelId`.
  - The service or adapter that produces the output sets these fields. They must never be copied from a model's or provider's raw response.
  - Today every stage reports `mock`, and `summarizeSourcingRun` flags the run as synthetic if any of these fields is `mock`.

### Real image understanding (GPT-6 Luna)

`OpenAIImageUnderstandingService` implements `ImageUnderstandingService`:

```
ReferenceImage → ReferenceImageContentProvider.load → ImageContent (bytes, MIME)
  → OpenAIVisionClient.analyzeImage  (one Responses API call, Structured Outputs)
  → raw vision response   (untrusted; validated by rawVisionAnalysisSchema)
  → mapRawAnalysisToFingerprint  (+ application-owned id, reference, createdAt, provenance)
  → furnitureFingerprintSchema   (existing P0-004 validation)
```

- **Request:**
  - Model from `OPENAI_IMAGE_UNDERSTANDING_MODEL` (default `gpt-6-luna`).
  - Instructions from `understanding/openai/instructions.ts`. The image goes as a base64 data URL with `detail: "high"`.
  - Reasoning `low`, `max_output_tokens` 4096, 60 s timeout, `store: false`, no tools.
  - `maxRetries: 0` on both the client and the request, so one call is at most one paid request.
- **Raw response vs. fingerprint:**
  - The model fills a separate raw schema: an `outcome` (`furniture_identified | no_furniture | ambiguous_target | unreadable_image`), a short reason, and a nullable `furniture` object (category, subtype, structure, appearance, distinctive features, search queries).
  - Every feature has a certainty, and its value is `null` when the certainty is `unknown`.
  - The schema stays within the Structured Outputs subset: a root object, all fields required, `null` for absence, strict objects, and no refinements or string length limits.
  - It asks for **no** ids, timestamps, model ids or provenance.
- **Mapping** sets the trusted fields itself:
  - `referenceImageIds: [reference.id]`, a generated fingerprint id and `createdAt`.
  - `source = { kind: "model", dataSource: "live", modelId }`, where `modelId` is the model reported in the API response.
  - It normalises names to snake_case and trims, de-duplicates and caps search queries at 5.
  - Non-furniture outcomes raise `FurnitureNotIdentifiedError`. Inconsistent output (e.g. an unknown feature with a value, an observed feature without one) raises `VisionModelError("malformed_output")`. Nothing is invented to fill gaps.
- **Errors:** `VisionModelError.category` is one of `refusal`, `incomplete`, `missing_output`, `malformed_output`, `authentication`, `permission`, `model_not_found`, `bad_request`, `rate_limit`, `timeout`, `network`, `server_error` or `unexpected`.
  - Messages never include the image, the key or full payloads, and the request id is kept.
  - Failures are never replaced with mock output. Inside `SourcingPipeline`, they surface as `image_understanding` stage errors.
- **CLI:** `pnpm analyze:image --file <path>` is a dry run by default (no network). `--live` sends one request. Secrets are read from `apps/web/.env.local` via `@next/env`.

**Implemented vs. planned:**
- Image understanding has a real provider implementation, run locally through the CLI. The pipeline still wires the mock by default.
- Discovery has a real, operator-assisted intake path (`pnpm source:candidates`) and an automated provider path (`pnpm discover:marketplace`, third-party provider, not yet run live; access and data-use approval unresolved). The mock adapter remains for synthetic runs.
- Visual shortlisting is real: local SigLIP 2 embeddings rank recorded candidates by cosine similarity, as a separate retrieval-stage result.
- Detailed visual verification has a real GPT-6.1 Sol implementation (`pnpm verify:visual`), run on the four Ettrick candidates. Without a Sol result, real candidates stay "not assessed"; the synthetic stub remains for demos.
- Offline orchestration (`pnpm source:auto`) assembles a consolidated result ordered by the Sol index; the `SourcingPipeline` provisional ranking remains a placeholder.
- There is no live end-to-end Alibaba sourcing workflow yet.
- Each real integration will also need an adapter that maps raw model or provider output into the domain types, setting provenance itself, before the pipeline's validation runs.
- Planned: an authorized Alibaba integration (discovery) and a production ranking policy.
- There is no live Alibaba integration. It is waiting on confirmation of an authorized integration.

## Components

| Component          | Technology                                     | Status   |
| ------------------ | ---------------------------------------------- | -------- |
| Web app            | Next.js (App Router), TypeScript, Tailwind CSS | Simple view (`/sourcing`) and advanced workspace (`/sourcing/workspace`); local-only, no auth |
| Image embeddings   | Python (`services/vision`), PyTorch, Hugging Face Transformers, SigLIP 2; local CLI component | Implemented (shortlisting); no server |
| Database           | PostgreSQL (searches, candidates, results)     | Planned  |
| Object storage     | S3-compatible (reference and candidate images) | Planned  |
| Alibaba adapter    | Interface, mock, operator-assisted curated intake, and an Apify third-party provider adapter | Provider adapter implemented; live use awaiting an access decision and first authorized run |
| Sourcing pipeline  | TypeScript orchestrator; synthetic and curated (saved fingerprint + operator candidates) compositions | Implemented; verified composition available (Sol), not run live yet |
| Image understanding | OpenAI Responses API (GPT-6 Luna), local CLI | Implemented |
| Visual verification | OpenAI Responses API (GPT-6.1 Sol), local CLI | Implemented; run on Ettrick |
| Orchestration      | TypeScript (`orchestration/`), `pnpm source:auto` | Implemented offline; live acquisition blocked on authorization |

## Open decisions

- Which authorized Alibaba integration is available and its rate limits/terms.
- Whether embeddings are stored in PostgreSQL (e.g. pgvector) or computed on demand.
- Synchronous request vs. background job for a search.
- Ranking weights between visual and seller signals (to be set from evaluation data).
