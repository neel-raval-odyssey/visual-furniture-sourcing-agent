# Evaluation Plan

How we will measure whether the system finds the right furniture. No results exist yet; this document defines the method only.

## Stage 1: Image understanding (implemented tooling, P0-006)

A working API integration doesn't show that the model describes furniture correctly. Before we tune instructions or build on the fingerprints, we measure the current GPT-6 Luna stage on its own. Tooling and the workflow are in [`evals/image-understanding/`](../evals/image-understanding/README.md).

- **Frozen baseline:** model `gpt-6-luna`, instructions `2026-10-24.1`, detail `high`, reasoning `low`, 4096 output tokens. Changing any of them mid-dataset would mix incomparable results, so runs with other settings are excluded and reported.
- **Dataset:** about 20 photographs the team is entitled to use: 4 beds, 4 chairs, 4 tables, 4 sofas, 2 ambiguous multi-object scenes and 2 non-furniture or unreadable images.
  - Across the furniture cases, mix studio and lifestyle shots, unusual angles, occlusion, styles and sources.
  - These are targets, not quotas. Only the Ettrick bed is defined so far, as a provisional case.
- **Annotations:** written by humans. Each case records the expected outcome; for furniture, also the category, acceptable subtypes, critical and supporting features (flagged if distinctive), known occlusions, unverifiable properties and claims the model must not make. Annotations stay `provisional` until adjudicated.
- **Layer A, automated (from saved run records):**
  - Coverage of cases.
  - Model outcome returned vs. API errors, by type.
  - Expected-outcome accuracy, excluding errors, with an outcome confusion table.
  - Category accuracy for furniture cases that identified furniture.
  - Completeness counts. These measure quantity, not correctness.
  - Token usage and duration. Reasoning tokens are part of output tokens; cost isn't estimated.
- **Layer B, human review (against the photograph, judging meaning rather than wording):**
  - Primary-object selection.
  - Critical, supporting and distinctive feature coverage (captured, partial, missed or contradicted).
  - Unsupported assertions.
  - Uncertainty quality.
  - Preliminary 1–5 search-query ratings. These are not retrieval results.
- **Reporting rules:**
  - Every rate states its denominator. Missing runs and incomplete reviews are listed.
  - There's no combined score.
  - Synthetic fixtures are labelled as such, and small samples carry an explicit limitation.
- **Not used in this phase:** AI-as-judge scoring and automated string matching for visual correctness.

The stages below cover cross-source matching and will be evaluated once discovery and verification are real.

## What we are evaluating

Cross-source matching: a reference photo from one source (retailer site, Instagram, Pinterest, a room photo) against Alibaba listing images taken by different sellers, with different lighting, angles, backgrounds and colourways.

## Dataset

- A labelled set of reference images, each paired with candidate listings judged by a human as:
  - **Exact** — same design (likely same factory/mould), colour may differ.
  - **Close** — same silhouette and key features, minor differences.
  - **Related** — same category and style, clearly different design.
  - **Wrong** — not a meaningful match.
- Cover multiple categories (chairs, sofas, tables, beds, storage, lighting) and photo types (clean product shot, lifestyle/room shot, cropped/partial, low quality).
- Include hard negatives: items of the same category and style that differ in a defining detail (arm shape, leg style, tufting).
- Keep a held-out test split that is never used for tuning prompts, thresholds or weights.

## Metrics

**Ranking quality**

- Recall@K (K = 1, 5, 10): share of queries with at least one Exact/Close match in the top K.
- MRR: reciprocal rank of the first Exact/Close match.
- nDCG@10 using graded relevance (Exact > Close > Related > Wrong).

**False positives**

- Precision@K for Exact/Close.
- Rate of Wrong or Related items labelled "Exact"/"Close" by the detailed comparison step.
- Calibration: does the model's stated confidence track actual correctness?

**Stage-level**

- Discovery recall: did the adapter return any true match at all? (Separates search failures from ranking failures.)
- Embedding shortlist recall: share of true matches that survive the shortlist cut-off.
- Detailed-comparison agreement with human labels.

**Operational**

- End-to-end latency and cost per search.

## Process

1. Build the labelled dataset with clear labelling guidelines; double-label a subset to measure inter-annotator agreement.
2. Establish an embedding-only baseline.
3. Add the detailed comparison stage and measure the change against the baseline.
4. Analyse failures by category, photo type and stage.
5. Re-run the suite on every change to models, prompts, thresholds or ranking weights.

## Risks to watch

- Leakage between tuning and test sets.
- Colour variants inflating "Exact" matches or being wrongly penalised.
- Watermarks, logos or text in listing images driving similarity.
- Duplicate listings of the same product from multiple sellers dominating the top K.
