# Architecture

Planned design. Nothing below is implemented beyond the web app shell. Model choices are proposals.

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
- Model (proposed): **GPT-6 Luna**.
- Output: furniture category, key visual attributes (silhouette, materials, colour, legs/base, upholstery, proportions), style tags, and several search queries. If the photo contains several items, identify the target item (possibly with a crop).

### 2. Candidate discovery

- An `AlibabaDiscoveryAdapter` interface isolates the source. Implementations will only use a **confirmed, authorized integration** (official API or approved partner). No scraping.
- `MockAlibabaDiscoveryAdapter` (fixture-backed, no network) backs development and tests. See [Code structure](#code-structure).
- Output: normalized candidate records (listing ID, title, images, price range, MOQ, seller reference, source URL).

### 3. Visual comparison

Two stages, to keep cost bounded:

1. **Embedding similarity** — **SigLIP 2 So400m Patch14-384** embeddings for the reference image and candidate images, computed by a Python service (PyTorch + Hugging Face Transformers). Cosine similarity ranks candidates and produces a shortlist.
2. **Detailed comparison** — **GPT-6.1 Sol** (proposed) compares the reference with each shortlisted candidate attribute by attribute and returns a structured verdict (match level, matching and differing features, confidence).

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
- `discovery/mock/`: `MockAlibabaDiscoveryAdapter` and synthetic fixtures (example.com URLs, `[MOCK]` titles, `dataSource: "mock"`). It applies simple category and text filters, keeps fixture order and makes no network requests.
- `understanding/`: `ImageUnderstandingService.analyze(reference) → FurnitureFingerprint`. The mock looks up hand-written fingerprints by reference id. It doesn't read pixels, and it throws `UnsupportedReferenceError` instead of inventing a fingerprint.
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

**Implemented vs. planned:** every stage currently runs on synthetic stubs.
- Each real integration will also need an adapter that maps raw model or provider output into the domain types, setting provenance itself, before the pipeline's validation runs.
- Planned: GPT-6 Luna (image understanding), an authorized Alibaba integration (discovery), SigLIP 2 and GPT-6.1 Sol (verification), and a production ranking policy.
- There is no live Alibaba integration. It is waiting on confirmation of an authorized integration.

## Components

| Component          | Technology                                     | Status   |
| ------------------ | ---------------------------------------------- | -------- |
| Web app            | Next.js (App Router), TypeScript, Tailwind CSS | Shell    |
| Embedding service  | Python, PyTorch, Hugging Face Transformers     | Planned  |
| Database           | PostgreSQL (searches, candidates, results)     | Planned  |
| Object storage     | S3-compatible (reference and candidate images) | Planned  |
| Alibaba adapter    | Interface + mock implemented; live integration TBD | Live blocked on confirmation |
| Sourcing pipeline  | TypeScript orchestrator + synthetic stage stubs | Implemented (stubs only) |

## Open decisions

- Which authorized Alibaba integration is available and its rate limits/terms.
- Whether embeddings are stored in PostgreSQL (e.g. pgvector) or computed on demand.
- Synchronous request vs. background job for a search.
- Ranking weights between visual and seller signals (to be set from evaluation data).
