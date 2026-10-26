# P0-007: Improvement and experiment plan

**Status:** proposal for review. No experiment has been run, and nothing here is a result.
**Companion documents:**
- `P0-007-image-understanding-baseline-analysis.md` (evidence; failure ids B1–B9);
- `image-understanding-instructions-v2-proposal.md` (candidate text, not active).

All thresholds below are **proposed targets**, not results or guarantees.

---

## 1. Comparison of intervention approaches

| Criterion | A: Revise Luna instructions | B: Separate query generation | C: Enrich the fingerprint schema |
| --- | --- | --- | --- |
| Addresses | B2, B3, B4, B6, B7. Partly B8 and B9 | B8, B9 (only for features labelled correctly), B5 hedge loss | B6, B7, B9 provenance. Not B2 or B3 |
| Expected benefit | Medium to high. Most failures look like reporting or labelling problems that the current text never asks about | High for query coverage: broad and synonym queries are guaranteed by construction | Low to medium now. The existing types can already express most of the distinctions, but the model doesn't use them |
| Strength of evidence | Moderate. The text-level causes are clear (the "omit attributes" and "combine the category with" wording). The effect is untested | Strong for the gap (0/10 broad; synonyms). No evidence on retrieval benefit | Weak. The one representation gap with no workaround is the accessory role (1 case) |
| Complexity | Low (text plus a version) | Medium (deterministic module, synonym table, offline checks) | Medium to high (raw schema, mapping, domain, validation, tests, every consumer) |
| Runtime cost and latency | More input tokens (instructions roughly double, about +500 tokens estimated). Output may grow | Deterministic: none. A model-based variant would add a call | Small output growth |
| Maintainability | Instruction complexity grows. Behaviour is not guaranteed | Rules are explicit, reviewable and unit-testable. The synonym table needs curating | More contract surface; drift guards already exist |
| Backward compatibility | Full: same raw schema and fingerprint | Full: additive output beside `searchQueries` | Breaking for raw-schema consumers unless optional |
| Regression risk | Over-hedging; losing useful distinctive queries; model variability | Generic queries; it propagates any fingerprint error labelled `observed` (it can't fix marl alone) | Model fills new fields inconsistently |
| Testability | Needs paid live runs plus human review | Fully offline on the 10 saved fingerprints | Needs live runs |
| Effect on discovery and verification | Better-labelled fingerprints help both | Directly shapes discovery; queries carry feature provenance | Helps verification (role and evidence status per feature) |

### Preferred initial intervention

The two approaches handle different failures, so this is **A and B in parallel, each as its own experiment. C is deferred.**

1. **B (deterministic query builder), offline, first.**
   - It needs no paid requests and directly addresses the most frequent problem (B8: 10/10 cases).
   - It produces queries with built-in provenance: each query is generated from named, observed, intrinsic features.
   - It cannot fix a feature mislabelled `observed`, which is why A is needed.
2. **A (instructions v2), live, developer-run.** It targets labelling and geometry. The two blocks are tested separately:
   - **G:** grounding, styling and the query mix (Exp 1);
   - **S:** structural geometry (Exp 2).
3. **C only if Exp 1 fails on accessories or function.** That is, if v2-G still promotes styling objects or unverified functions into distinctive features or queries. Then propose a minimal optional field, e.g. a role on features. **Do not build a scene graph:** text values already carry relationships well (advait-three-seater, chandra-one-seater).

**Tradeoff accepted:** running A and B together means a final configuration has two changes. They act on different outputs (fingerprint versus queries) and are measured with separate metrics, so their effects remain distinguishable.

---

## 2. Controlled experiment definitions

### Common protocol

- **Frozen control:** `gpt-6-luna`, instructions `2026-10-24.1`, detail `high`, reasoning `low`, 4096 output tokens, the current raw schema.
  - The 10 existing baseline records stay untouched.
  - New control runs go in a separate predictions directory, one per arm.
- **Inputs:** the same 10 images. Hashes are checked through `--images`.
- **Concurrent control:** control and treatment runs happen in the same session period, so model drift behind the alias affects both arms. The reported model is recorded per run.
- **Repeats:** run-to-run variation is unmeasured; the anecdotal Ettrick top-cap difference suggests it exists.

  | Design | Runs per case per arm | Requests (Exp 1 + 2, 3 arms) | Reviews |
  | --- | --- | ---: | ---: |
  | Recommended | 2 | 60 | 60 |
  | Minimal | 1 | 30 | 30 |

  - In both designs the existing baseline record counts as one extra control replicate.
- **Aggregating repeats:**
  - Report each feature's judgement in every replicate.
  - For **regressions**, use the *worst* judgement across a treatment's replicates (conservative).
  - For **improvements**, require the better judgement in *every* treatment replicate.
- **Blind review:**
  - Packets show the run output without arm or version labels, in randomised case and arm order.
  - The reviewer uses the same rubric and the same feature definitions.
  - Annotations are not changed between arms.
- **Development-set caveat:**
  - The 10 cases were used to find the problems, so any improvement on them may be overfitted.
  - Before shipping a configuration, confirm on 6–10 **unseen** photographs, annotated before inference. They should include lifestyle, multi-object and at least one non-furniture image.
  - That confirmation is not required for P0-007.
- **No combined score.** Each metric family is judged on its own.

### Experiment 1: Grounding, styling and query mix (instruction block G)

| Item | Definition |
| --- | --- |
| Hypothesis | Making certainty apply to function and hidden parts, excluding styling, and requiring a query mix reduces unsupported constraints without losing visible features |
| Variable | Instruction text: `2026-10-24.1` → `v2-G` (the candidate without the `[S]` lines). Nothing else changes |
| Control | Baseline instructions, run concurrently |
| Inputs | 10 development images |
| Primary outcome | Unsupported functional, material or styling claims appearing as `observed` features, distinctive features or query terms, counted per case. Baseline (analyst count): marl drawers; ashford bolster and leather in queries; chandra "dining". Reviewer-confirmed: marl, ashford bolster |
| Secondary outcomes | Uncertainty judgement; offline query checks (section 3); query rating; critical, supporting and distinctive capture |
| Regression checks | No critical feature becomes missed or contradicted. Primary object and category stay 10/10. The positive behaviours stay: alden lamp excluded, denby "three visible", no brands or dimensions. No over-hedging: visible geometry must not be pushed to `inferred` or `unknown` |
| Failure criteria | Any case gains a new unsupported claim. More than 1 critical-feature regression. Structured-output validity below 100%. Operational limits exceeded (section 4) |
| Cost | Recommended design: 20 new requests for this comparison (10 cases × 2 replicates × 2 arms). At the baseline mean of 3,653.5 tokens per request, about 73k tokens, more if v2 output grows. Plus 20 reviews |
| Decision rule | **Adopt v2-G as the next candidate** if the primary outcome falls to 0 cases in every replicate (target), no regression criterion fails, and operational limits hold. **Reject or revise** if unsupported claims persist in 2 or more cases or regressions occur. **Escalate to approach C** if styling or function claims persist despite the wording |

### Experiment 2: Structural geometry (instruction block S)

| Item | Definition |
| --- | --- |
| Hypothesis | Asking explicitly for footprint, relative size and position, connection direction, projections and overhangs, and for defining absences turns partial or missed geometry into captured. If it doesn't, the cause is perception rather than reporting |
| Variable | `v2-G` → `v2` (adds only the `[S]` lines) |
| Control | v2-G runs from Exp 1, which share the session |
| Inputs | Same 10 images. There are **11 focus features**: the 6 partial critical features other than marl's apron (that one belongs to Exp 1), plus the 5 supporting features not fully captured. By case: amber pedestal and grooves; ashford backrest; aeris beam and overhang; denby body, low-profile and armless; marl junctions and lip; aisha armless |
| Primary outcome | Number of the 11 focus features judged *captured* in every v2 replicate |
| Secondary outcomes | Reviewer judgement on whether the aeris beam is described with the correct direction and connections; any new unsupported geometric claims (`incorrect_geometry`, `not_visible`) |
| Regression checks | Every feature already captured stays captured or better. Output-token growth stays within limits. Distinctive features don't become filled with absences |
| Failure criteria | Fewer than 3 of the 11 focus features improve, which implicates perception. New incorrect-geometry claims appear in 2 or more cases |
| Cost | 20 additional requests (v2 × 2 replicates), about 73k or more tokens, plus 20 reviews |
| Decision rule | **Adopt S** if at least 5 of 11 focus features improve to captured (target) with no geometry regressions. **If 3 or fewer improve**, do not add more wording. Plan a separate single-variable test of image crops *or* reasoning effort (`low` → `medium`), not both at once |

### Experiment 3: Deterministic query expansion (offline)

| Item | Definition |
| --- | --- |
| Hypothesis | Broad-to-specific templates plus a curated category synonym table, built only from `observed` intrinsic features, give better coverage (broad and synonym queries) than Luna's queries, without unsupported terms |
| Variable | Query source: Luna `searchQueries` → deterministic builder output (or a union of the two, as a second arm) |
| Control | Luna queries in the 10 saved baseline fingerprints. Later, also v2 fingerprints |
| Inputs | The saved fingerprints only. No API calls, no cost |
| Primary outcome | Offline query checks (section 3): broad query present, category-term coverage, unsupported-term lint |
| Secondary outcomes | Blinded human comparison of query sets: which set would you search with? Rating per set. Distinctive-term inclusion |
| Regression checks | Distinctive-term inclusion doesn't fall below Luna's (10/10). No accessory or inferred-feature terms |
| Failure criteria | Lint hits that Luna's queries don't have. Blinded human preference against the builder in a majority of cases |
| Known limitation | On baseline marl-study-table, drawers are labelled `observed`, so the builder would still use them. Exp 3 alone cannot fix B4; the combination with Exp 1 is what matters |
| Decision rule | **Adopt as an additional query set** (beside Luna's, not replacing them) if checks pass and human preference is neutral or better. **Replacing** Luna's queries requires retrieval evidence (Recall@K), which needs authorised Alibaba access |

---

## 3. Success criteria (proposed targets)

These are reported separately; there is no weighted score.

| Family | Metric | Baseline | Proposed target |
| --- | --- | --- | --- |
| Identification | Correct primary object | 10/10 | No regression |
| Identification | Category accepted, and exact primary category | 10/10 and 7/10 | No regression in accepted; exact match reported only |
| Geometry | Critical captured / missed or contradicted | 22/29 / 0 | ≥ 25/29 captured with v2 (Exp 2); 0 missed or contradicted |
| Geometry | Distinctive captured | 15/21 | ≥ 18/21 (a subset of critical in this dataset) |
| Geometry | Supporting missed | 3/41 | ≤ 1/41 |
| Geometry | Unsupported geometric claims | 0 | 0 |
| Grounding | Cases with unsupported functional, material or styling claims (as observed, distinctive or query) | 1 confirmed (marl), up to 3–4 by analyst count | 0 |
| Grounding | Uncertainty judged overconfident | 2/10 | ≤ 1/10 |
| Grounding | Over-hedging (visible geometry marked inferred or unknown) | not measured | ≤ 1/10 (needs rubric T2) |
| Grounding | Styling elements in distinctive features or queries | 1/10 | 0/10 |
| Queries (offline) | Broad query present | 0/10 | ≥ 9/10 |
| Queries (offline) | ≥ 2 distinct accepted category terms across the set | not measured | ≥ 8/10 |
| Queries (offline) | Unsupported-term lint hits | to be computed in T3 | 0 |
| Queries (offline) | Distinctive term included | 10/10 | 10/10 |
| Queries (human) | Mean rating; per-case change | 3.4 | ≥ baseline; no case drops more than 1★ |
| Operational | Structured-output validity; failed inference | 10/10; 0 | 100%; 0 (excluding transient network errors, which are re-run and reported) |
| Operational | Median output tokens / median total tokens / median duration, compared with the *concurrent* control | 647.5 / 3,259 / 11,100 ms | ≤ +40% / ≤ +30% / ≤ +30% |

**Offline query-check definitions** (heuristics, to be implemented in T3; human review stays authoritative):
- **Broad query:** at most 4 words, containing an accepted category term. Accepted terms are the case's category, `alsoAcceptableCategories`, acceptable subtypes, or the synonym table, with underscores treated as spaces.
- **Category-term coverage:** the number of distinct accepted category terms used across a case's queries.
- **Unsupported-term lint:** query terms matching a per-case list of disallowed terms derived from the case's `unsupportedClaims` and styling notes, plus a global list of wood species and of unqualified "leather". Examples: marl, "drawer"; ashford, "bolster" and unqualified "leather". This needs an optional, additive dataset field reviewed by the annotator. It checks query constraints, not visual correctness.

**Future retrieval metrics** (need authorised Alibaba discovery; not available now):
- Discovery Recall@K per query strategy: was any human-labelled Exact or Close candidate returned?
- Union recall across the query set.
- Candidates returned per query, including zero-result queries.
- Precision of the top K.

Query ratings are not a substitute for these.

---

## 4. Cost and latency considerations

- **Baseline per request:** 2,886–4,615 total tokens (mean 3,653.5) and 7.6–14.4 s (median 11.1 s). Input is 2,375 or 3,911 tokens, depending on the image.
- **Candidate v2:** about 500 extra input tokens estimated, plus whatever output growth occurs. This is measured against the concurrent control. **No currency cost is estimated here.**
- **Experiment budget:** 60 requests in the recommended design or 30 in the minimal one. At baseline means that is roughly 220k or 110k tokens, more if output grows. Human review is the larger cost: 60 or 30 reviews.
- **Deterministic query builder:** no runtime model cost and negligible latency.
- **Avoid:** automatic fallback, retries that hide cost (`maxRetries` stays 0), and running experiments without explicit `--live` and an explicit candidate flag.

---

## 5. Regression risks

| Risk | Mitigation |
| --- | --- |
| Over-hedging: visible details pushed to `inferred` | Over-hedging rubric category (T2); count of visible geometry labelled observed |
| The query mix displaces a useful distinctive query (5-query cap) | Exp 3 union arm; the distinctive-term check |
| Longer instructions are followed less consistently | Two blocks tested separately; repeats |
| Overfitting to 10 development images | Unseen hold-out before shipping |
| Reviewer bias towards the new version | Blind packets |
| Synonym table encodes wrong marketplace vocabulary | Treat it as data, reviewed by the developer; validate with retrieval later |
| Mixing arms in one directory triggers "superseded" logic | One predictions directory per arm, and per-arm settings in the evaluator (T1) |
| Model alias drift between sessions | Concurrent control; reported model recorded per run |

---

## 6. Prioritized implementation tasks

In dependency order. "Immediate" tasks need no marketplace data.

| ID | Title | Problem addressed | Baseline evidence | Proposed implementation | Depends on | Acceptance criteria | Complexity | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Experiment-arm support | Candidates can't be run or evaluated today: `analyze:image` always uses the active instructions, and the evaluator excludes runs that differ from the baseline | Infrastructure gap; the baseline is in `dataset.json` | A versioned instruction registry: active stays `2026-10-24.1`, and candidates are selectable only with an explicit `--instructions <version>` flag plus `--live`. The evaluator accepts an arm config (expected settings) per predictions directory. A paired comparison report (per-case, per-feature judgement changes, token and latency deltas). Blind review-packet export. Optionally, record image pixel dimensions in run records | — | Default request unchanged (tests assert the baseline text and version). A candidate can't be used without the explicit flag. The comparison report is deterministic and offline. No live calls in tests | Medium | **P1 (immediate)** |
| T2 | Rubric clarifications | "Insufficiently informative" used with two meanings; "broad query" undefined; no tags for styling or function | 3 reviews; 0/10 broad judged strictly | Split uncertainty into `overconfident`, `missing_decision_relevant_unknowns`, `over_hedged`; written query-flag definitions; additive failure tags `styling_contamination`, `unsupported_function`. Existing reviews keep validating (additive enums) | — | Old reviews validate unchanged. The review guide gives operational definitions | Low | **P1 (immediate)** |
| T3 | Deterministic query builder and offline query checks | B8, B9, B5 hedge loss | 0/10 broad; 4 synonym gaps; 3 propagation cases | A pure module: fingerprint (observed, non-styling features only) → broad, synonym and structural queries using a reviewed category synonym table. Offline checks as defined in section 3. Its own output field, not replacing `searchQueries`. Optional additive dataset field for the per-case disallowed terms | T2 for definitions | Exp 3 runs offline on the saved fingerprints. Unit tests prove that inferred, unknown and styling features never reach queries | Medium | P2 (immediate) |
| T4 | Register candidate instructions v2 (inactive) | Makes Exp 1 and 2 runnable | — | Add `v2-G` and `v2` as registered candidates from the approved proposal text. The active constant stays unchanged | T1, developer approval of the text | Tests prove the default is still `2026-10-24.1` | Low | P2 |
| T5 | Run Exp 1 and 2 (developer) | B2, B3, B4, B6, B7 | See the analysis | Live runs per protocol, then blind reviews | T1, T2, T4 | Records and reviews complete; comparison report produced | Developer effort | P2 |
| T6 | Analyse experiments and decide | — | — | Apply the decision rules; recommend activating or rejecting | T5 (and T3 for queries) | Written decision with per-metric evidence | Low | P3 |
| T7 | Feature-role schema field (conditional) | B6 and B4 if instructions are insufficient | Only if Exp 1 fails on them | A minimal optional field, e.g. a feature role of intrinsic, styling or uncertain, plus mapping and validation | T6 outcome | Backward compatible; drift guards pass | Medium to high | Conditional |
| T8 | Unseen hold-out confirmation set | Overfitting | All 10 are development images | 6–10 new photographs, annotated before inference, mixed conditions | Before shipping any change | Annotations written before runs | Developer effort | Before activation |
| T9 | Retrieval evaluation of query strategies | Query value unmeasured | No recall data | Recall@K per strategy against human-labelled candidates | An authorised Alibaba integration | Per-strategy recall with denominators | High | Blocked on marketplace access |

Crops and reasoning-effort tests are **not** scheduled. They are triggered only by an Exp 2 failure, and each would be a single-variable experiment.

---

## 7. Decisions requiring developer approval

1. **Failure classification:** accept or amend the analyst classification (baseline analysis, section 5).
2. **Adjudication of provisional annotations.** Specifically:
   - aeris-dining-table beam: partial, or a relationship error?
   - whether ashford-day-bed's unqualified "leather" queries and chandra-one-seater's "dining" and "bent" count as unsupported assertions.
   - No review or annotation has been changed.
3. **Species descriptors in queries:** "walnut-look" kept or replaced by colour wording. Affects v2 text and the lint.
4. **Approve the v2 candidate text,** including the broad-query wording and the query mix.
5. **Experiment budget:** recommended (2 replicates, 60 requests, 60 reviews) or minimal (1 replicate, 30 and 30).
6. **Blinding:** whether to require blind packets (T1) before running Exp 1 and 2.
7. **Thresholds:** accept, tighten or relax the targets in section 3.
8. **Query generation boundary:** add deterministic queries *beside* Luna's (recommended now). Replacement waits for retrieval data.
9. **Hold-out set:** composition and timing (T8).
10. **P0-008 scope:** recommended T1 plus T2 (see the final report).
