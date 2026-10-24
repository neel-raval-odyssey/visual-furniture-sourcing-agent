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
- **Validation between stages:**
  - The fingerprint must reference the input image.
  - Discovery must not return duplicate listing or supplier ids.
  - Each assessment must refer to a discovered listing, at most once, for the current reference and fingerprint, with similarity in 0–100 or null.
  - Ranking must return every listing exactly once, with ranks 1..n and correct supplier and assessment links.
- **Errors:** any stage failure or contract violation is raised as `SourcingPipelineError` with `stage` and the original `cause`. Failures are never replaced with fabricated data.
- **Empty discovery is not an error.** The run returns empty assessments and results.
- **Provenance** stays on the stage outputs (`fingerprint.source`, `discovery.provider.dataSource`, listing and supplier `provenance`, assessment `metadata`), so mock output can be told apart from real provider data.

**Implemented vs. planned:** every stage currently runs on synthetic stubs.
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
