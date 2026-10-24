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
- A mock/fixture adapter will back development and tests.
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

## Components

| Component          | Technology                                     | Status   |
| ------------------ | ---------------------------------------------- | -------- |
| Web app            | Next.js (App Router), TypeScript, Tailwind CSS | Shell    |
| Embedding service  | Python, PyTorch, Hugging Face Transformers     | Planned  |
| Database           | PostgreSQL (searches, candidates, results)     | Planned  |
| Object storage     | S3-compatible (reference and candidate images) | Planned  |
| Alibaba adapter    | Authorized integration, TBD                    | Blocked on confirmation |

## Open decisions

- Which authorized Alibaba integration is available and its rate limits/terms.
- Whether embeddings are stored in PostgreSQL (e.g. pgvector) or computed on demand.
- Synchronous request vs. background job for a search.
- Ranking weights between visual and seller signals (to be set from evaluation data).
