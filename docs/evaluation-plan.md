# Evaluation Plan

How we will measure whether the system finds the right furniture. No results exist yet; this document defines the method only.

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
