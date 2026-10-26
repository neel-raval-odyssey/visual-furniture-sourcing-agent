# P0-007: Image-understanding baseline analysis

**Status:** analysis for review. Nothing here changes the active configuration.
**Baseline:** `gpt-6-luna`, instructions `2026-10-24.1`, image detail `high`, reasoning `low`, 4096 max output tokens, Structured Outputs. Dataset `image-understanding-baseline` v1.2.0-draft.
**Evidence:** 10 run records and 10 complete human reviews (private, not committed), the shared `dataset.json`, and the evaluator report. Cases are referred to by id. No paths, response ids or full model responses appear here; short quotes from model output are included where a claim depends on wording.

Two kinds of claim are kept apart throughout:

- **Recorded:** directly in the run records or reviews.
- **Hypothesis:** an explanation of *why* something happened. None has been tested.

The classification of reviewer findings into failure types (section 5) is the analyst's own and has not been adjudicated.

---

## 1. Executive technical summary

1. **Recognition is reliable on this set.**
   - The model picked the right object in all 10 cases, and its category was accepted in all 10.
   - No critical or distinctive feature was missed or contradicted (29/29 critical features captured or partial).
   - All 10 responses were valid structured output, with no errors.
2. **The losses are in precision, grounding and search queries, not perception.**
   - **Precision:** 7 of 29 critical features were only partial. Four of the seven involve how parts relate (relative size, position, extent or connection).
   - **Missed details:** all 3 missed supporting features are either an *absence* (armless) or an *edge projection* (tabletop overhang ×2).
3. **The certainty labels are barely used for structure.**
   - Across 131 features, the model used `inferred` 14 times, and never for structure: 10 are `style` and 4 are material or finish.
   - Hidden or functional facts were labelled `observed`: four legs when two were visible (alden-side-table), and working drawers on a seamed apron (marl-study-table).
4. **Query generation is the weakest and most consequential output.**
   - No case had a broad, category-first query (0/10). This is what the current instructions ask for: they say to "combine the category with distinctive design features".
   - All 40 queries are 6–10 words long.
   - Category synonyms are missing where listings would plausibly use them (nightstand, daybed, couch, accent chair).
   - Wording hedged in the fingerprint loses its hedge in the queries: "leather-like" becomes "leather" (3 queries); a possibly removable bolster appears in 2 queries; unverified drawers appear in 3 queries.
5. **Answer to Question 1 (suitability):** provisionally yes, for clean single-item product photographs. Nothing recorded points to a perception ceiling that would justify changing model. Suitability for lifestyle scenes, clutter, ambiguity, poor images and non-furniture is untested.
6. **Recommended direction:** see the experiment plan for details.
   - Tighten grounding and geometry wording in the instructions (candidate `v2`, inactive).
   - Move query *broadening* into a deterministic downstream step that only uses observed, intrinsic features.
   - Test both against the frozen baseline, with repeat runs to measure run-to-run variation, before changing anything in production.

---

## 2. Verified baseline metrics

All figures were recomputed from the records, independently of the evaluator. The evaluator was also re-run offline and produced a report identical to the saved one apart from run id and timestamp; the input fingerprint was unchanged.

Checks performed:
- All 10 runs use the baseline settings.
- Every review's `responseId` matches its run, so no review is stale.
- All 10 image hashes match `dataset.json`.

| Metric | Reported | Recomputed | Note |
| --- | ---: | ---: | --- |
| Real photographs | 10 | 10 | |
| Completed human reviews | 10 | 10 | |
| Correct furniture category | 10/10 | 10/10 | Only **7/10** match the annotated primary category exactly; 3 match a listed alternative (see below) |
| Correct primary object | 10/10 | 10/10 | |
| Critical captured | 22/29 (75.9%) | 22/29 | 7 partial, 0 missed |
| Critical captured or partial | 29/29 | 29/29 | |
| Supporting captured | 36/41 (87.8%) | 36/41 | 2 partial, 3 missed |
| Distinctive captured | 15/21 (71.4%) | 15/21 | All 21 distinctive features are also critical, so this is a subset of the critical metric, not an independent one |
| Distinctive captured or partial | 21/21 | 21/21 | |
| Appropriate uncertainty | 5/10 | 5/10 | 2 overconfident, 3 insufficiently informative (but see the rubric note below) |
| Reviews with unsupported assertions | 1/10 | 1/10 | marl-study-table |
| Mean query rating | 3.4/5 | 3.4 | Median 3.5. 4★ ×5, 3★ ×4, 2★ ×1 |
| Broad category-first query | 0/10 | 0/10 | |
| Explores alternatives | 7/10 | 7/10 | |
| Excessively narrow | 4/10 | 4/10 | alden, ashford, ettrick, marl |
| Total tokens | 36,535 | 36,535 | |
| Mean total tokens per image | 3,653.5 | 3,653.5 | Range 2,886–4,615 |
| Mean duration | 10,950.5 ms | 10,950.5 ms | Median 11,100; range 7,590–14,401 |

**No numeric discrepancies.** Four points qualify how the numbers should be read:

1. **Category leniency.** Three cases were accepted through `alsoAcceptableCategories`:

   | Case | Model category | Annotated category |
   | --- | --- | --- |
   | alden-side-table | `chest_of_drawers` | `nightstand` |
   | ashford-day-bed | `chaise_lounge` | `day_bed` |
   | denby-stool | `ottoman` | `stool` |

   These are reasonable matches, but the label the model chooses decides its query vocabulary. In alden-side-table, all four queries use chest or cabinet terms (section 4).
2. **Rubric drift on "insufficiently informative".** The review guide defines it as *"Everything is hedged; useful visible details are missing"*. The three reviews that use it (advait, aeris, denby) mean the opposite: the model did not mention hidden or unverifiable construction. The review data has not been changed. The rubric needs either a clarification or a separate category (see the experiment plan).
3. **"Broad category-first query" has no operational definition** in the review guide. The reviewer applied it strictly: "dark brown panel bed arched headboard" was judged not broad. An offline check needs a written rule.
4. **The report's "Observed in runs" column is blank for detail and reasoning.** This is a display gap in the report renderer, not missing data. The run records contain the request settings, and all of them equal the baseline.

**Not verifiable from current records:** the claim that an earlier Ettrick run omitted the projecting top cap. That run predates the evaluation record format and was not saved. The saved run does capture the cap. Treat it as anecdotal evidence of run-to-run variation.

### Operational detail (recorded)

| Case | Input | Output | Reasoning | Total | ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| ettrick-bed | 2,375 | 840 | 83 | 3,215 | 14,037 |
| aisha-chair | 2,375 | 928 | 70 | 3,303 | 12,537 |
| amber-coffee-table | 2,375 | 703 | 60 | 3,078 | 14,401 |
| ashford-day-bed | 3,911 | 562 | 0 | 4,473 | 10,218 |
| aeris-dining-table | 3,911 | 513 | 49 | 4,424 | 8,038 |
| alden-side-table | 3,911 | 659 | 57 | 4,570 | 13,021 |
| chandra-one-seater | 2,375 | 585 | 0 | 2,960 | 9,450 |
| advait-three-seater | 2,375 | 636 | 45 | 3,011 | 8,231 |
| denby-stool | 3,911 | 704 | 52 | 4,615 | 11,982 |
| marl-study-table | 2,375 | 511 | 0 | 2,886 | 7,590 |

- **Input tokens take only two values.** They are 2,375 (six images) or 3,911 (four images). The instruction text is identical in every run, so the difference must come from the image.
  - **Hypothesis:** it reflects image-resolution tiling at `high` detail.
  - Pixel dimensions aren't recorded, so this can't be confirmed. File size doesn't predict it: aeris-dining-table, at about 0.9 MB, falls in the higher group.
- **Three runs reported 0 reasoning tokens:** ashford-day-bed, chandra-one-seater and marl-study-table. Two of these are the clearest grounding cases (the bolster and the drawers). With n = 3, this is an observation worth watching, not evidence that reasoning effort matters.
- **Validity and errors:** 10/10 responses were valid structured output, and there were no API, refusal or truncation errors. Every output stayed far below the 4096-token limit; the maximum was 928.

---

## 3. Dataset limitations

- **Size and composition.**
  - There are 10 photographs, one per collection.
  - 8 of the 10 are tagged `clean_product_photo`; two have multiple objects and three partial occlusion.
  - There are no lifestyle interiors, no highly ambiguous scenes, no poor-quality images and no non-furniture images.
  - The group and condition breakdowns have one to eight cases per row, so differences between them can't be interpreted.
- **Annotation status.**
  - All annotations are `provisional`, and there is effectively one annotator and reviewer.
  - Reviews were not blind to the model output; by design, the reviewer compares the two.
  - ettrick-bed was annotated *after* seeing a model response, so it is less independent. The other nine were annotated before inference, according to the case notes.
- **One run per case.** Run-to-run variation is unmeasured, so a single run can't show whether a feature is missed reliably or only occasionally.
- **No retrieval data.** Query ratings are human judgements; there is no Alibaba recall.
- **Not covered:** cross-source matching, manufacturer identity, and rejection of non-furniture images (all 10 cases are furniture, so the rejection path is untested on real images).
- **Development set only.** These images were used to find the problems, so they can't serve as an unbiased test of fixes.

The results are not statistically representative of real-world sourcing.

---

## 4. Case-by-case findings

Abbreviations:
- **C / P / M:** captured / partial / missed.
- **Crit, Supp:** critical, supporting.
- **D:** distinctive (all distinctive features here are also critical).

| Case | Category (model → expected) | Crit | Supp | Uncertainty | Queries (rating) | Main issue |
| --- | --- | --- | --- | --- | --- | --- |
| ettrick-bed | bed → bed | 2C | 4C | appropriate | 3★, narrow | No broad query |
| aisha-chair | chair → chair | 2C | 4C, 1M | appropriate | 4★ | Armless not stated |
| amber-coffee-table | table → table | 2C, 1P | 3C, 1P | appropriate | 4★ | Pedestal's relative size and position |
| ashford-day-bed | chaise_lounge → day_bed (alt) | 2C, 1P | 4C | appropriate | 3★, narrow | Bolster promoted; leather in queries |
| aeris-dining-table | table → table | 2C, 1P | 3C, 1M | insuff.* | 3★ | Beam relationship; overhang missed |
| alden-side-table | chest_of_drawers → nightstand (alt) | 3C | 4C | overconfident | 3★, narrow | Four legs "observed"; no nightstand term |
| chandra-one-seater | chair → chair | 3C | 4C | appropriate | 4★ | Armchair-only vocabulary |
| advait-three-seater | sofa → sofa | 4C | 3C | insuff.* | 4★ | No couch or settee terms; few unknowns |
| denby-stool | ottoman → stool (alt) | 1C, 2P | 4C, 1P | insuff.* | 4★ | Footprint shape; low projection; armless |
| marl-study-table | desk → desk | 1C, 2P | 3C, 1M | overconfident | 2★, narrow, fabricated | Drawers asserted and propagated |

\* "insufficiently informative" as used by the reviewer: hidden construction not discussed (see section 2).

### ettrick-bed

**Recorded:**
- Tall headboard, the row of arched panels ("Approximately seven vertical arches"), the projecting top rail, low footboard, turned feet and dark finish are all captured.
- Side rails are marked `unknown`, with an occlusion rationale.
- All four queries combine colour, subtype and headboard detail, at 6–8 words each. None is a broad "panel bed" or "wooden bed" query.

**Notes:**
- The arch count is hedged inside the value but labelled `observed`. This is benign here because seven is correct according to the annotation.
- The case is less independent because it was annotated after the model run.

### aisha-chair

**Recorded:**
- The splat, the open-back geometry, the rear legs continuing into the uprights, the apron and the finish are all captured.
- No arm attribute is emitted, so `armless-design` is missed.
- The frame material is correctly marked `inferred`.

**Hypothesis:** the structure section of the current instructions says "omit attributes that do not apply". That probably discourages stating absences.

### amber-coffee-table

**Recorded:**
- The pedestal is described as "Single short cylindrical pedestal beneath the tabletop", with no relative diameter and no setback.
- The ribs are captured, but the dark grooves between them aren't described.
- Material is `inferred` and dimensions `unknown`. Both are appropriate.
- Queries cover round, fluted, pedestal and ribbed variants.

**Failure types:** proportion and relationship underspecification (B3) and minor detail omission (B2).

### ashford-day-bed

**Recorded:**
- The asymmetric form is captured.
- The partial backrest appears only as "a tall, squared upholstered panel rises behind the right end", which is short of the annotated horizontal extent along part of the rear.
- The bolster appears in three places:
  - in structure, accurately: "resting across its top";
  - as a distinctive feature: `cylindrical_bolster`;
  - in 2 of 4 queries.
- The fingerprint says "leather-like", but all 3 leather queries say "leather" with no hedge.
- No query uses daybed terminology, although daybed is the annotated category.

**Notes:**
- The bolster is the clearest case of accessory contamination (B6) and propagation (B9).
- The leather wording is hedge loss at the query step (B5 and B9).
- The reviewer noted the leather issue but did not record it as an unsupported assertion. That is for adjudication.

### aeris-dining-table

**Recorded:**
- The model wrote "Sculpted wooden rails beneath the glass connect the legs along the long sides, with raised curved forms at the ends".
- The annotation describes a *central* longitudinal beam that joins the two transverse end supports.
- The reviewer gave partial credit. The overhang isn't mentioned (missed).
- No query mentions the beam.

**Notes:**
- The wording suggests perimeter side rails rather than one central beam. If the annotation is right, this is closer to a relationship error than to vagueness. That is worth adjudicating; the review hasn't been changed.
- This is the clearest spatial-relationship case (B3).

### alden-side-table

**Recorded:**
- The correct object was chosen despite the lamp and accessories, and none of the decor entered the fingerprint. This is a positive result for B6.
- The model wrote "Four slim, tapered legs; the two front legs are visible" with certainty `observed`. The evidence caveat is in the value, but the label overstates it.
- The category is `chest_of_drawers`.
- All 4 queries use chest, cabinet or drawer-chest wording. None uses nightstand or bedside.

**Failure types:** hidden-count overclaim (B7) and category-vocabulary lock-in (B8).

### chandra-one-seater

**Recorded:**
- All seven features are captured. The wraparound rail and front-post continuity are well described, and joints are `unknown`.
- All 4 queries say "armchair".
- One query says "upholstered dining armchair". "Dining" isn't among the annotated subtypes.
- Another says "bent curved wooden arm frame". The annotation lists one-piece bentwood construction as an unsupported claim.

**Notes:**
- Neither query term was flagged by the reviewer. They are analyst observations for adjudication.
- This is mild query drift (B8 and B9).

### advait-three-seater

**Recorded:**
- All seven features are captured, and the structural relationships are well represented.
- Only one feature isn't `observed` (style is `inferred`), and there are no `unknown` features.
- One query contains "walnut style frame".

**Notes:**
- The reviewer judged the walnut wording an acceptable descriptor.
- Whether the missing hidden-construction unknowns matter for *sourcing* is doubtful. This looks like harmless brevity rather than a material omission (B7, low severity).

### denby-stool

**Recorded:**
- The model wrote "roughly oval footprint"; the annotation says rounded-square, so the feature is partial.
- "Three visible chunky wooden supports … curve outward to the floor" is careful about the count, which is good. It doesn't describe how little the supports project below the body.
- The absence of a back is encoded as `backrest` with value `"None"` and certainty `observed`. Armlessness isn't stated.

**Notes:**
- The footprint is a shape-precision issue (B2).
- The low projection is relative position (B3).
- The literal `"None"` string shows the schema has no clean way to express an observed absence (a representation issue).

### marl-study-table

**Recorded:**
- `drawer_layout` is `observed`: "Four shallow drawers arranged side by side across the front apron."
- A distinctive feature reads "Four wide, handleless drawer fronts".
- 3 of 4 queries assume drawers.
- The annotation, written **before** inference, lists "Functional drawers asserted without evidence" as an unsupported claim.
- Curved junctions are partial, and the projecting tabletop lip is missed.
- The structure says "straight square-section legs", but a query says "tapered square legs". The annotation allows subtle tapering, so this is an internal inconsistency rather than an error.
- 0 reasoning tokens.

**Notes:** this is the clearest recorded case of unsupported functional inference (B4) carried through to queries (B9).

---

## 5. Failure taxonomy

Severity is judged for the sourcing use case:
- **High:** likely to exclude true matches or add a false constraint downstream.
- **Medium:** weakens discrimination.
- **Low:** cosmetic, or harmless brevity.

Counts are cases unless stated otherwise. "Confirmed" means the reviewer recorded it. "Analyst" means the classification is ours and still needs adjudication.

| Id | Definition | Affected cases | Count | Severity | Status | Candidate interventions |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Wrong primary object or category, or too unspecific a subtype | none | 0/10 wrong | — | Confirmed absent on this set | None now. Category *label choice* still affects queries (see B8). |
| B2 | Structural omission: visible geometry missing or mis-shaped | aisha (armless missed); denby (armless partial, footprint shape); aeris (overhang missed); marl (projecting lip missed, junction profile vague); amber (grooves) | 3 missed supporting features: 2 overhang or projection, 1 absence | Medium | Confirmed (reviews); grouping by analyst | Instruction: state defining absences; name projections, overhangs and footprint. Exp 2. |
| B3 | Spatial-relationship error: parts recognised, but relative size, position, extent or connection unclear or wrong | aeris (beam); amber (pedestal size and setback); ashford (backrest extent); denby (low projection) | 4 of 7 partial critical features | Medium to high (these are the distinctive cues) | Confirmed partial (reviews); classification by analyst | Instruction geometry block (Exp 2). If that fails: crops or a reasoning-effort experiment. A schema change isn't justified yet. |
| B4 | Unsupported functional inference: a shape stated as a verified function | marl (drawers) | 1 | High | Confirmed | Instruction: separate visible form from function. Deterministic rule: queries use only observed features. |
| B5 | Material overclaim | ashford (leather in queries); queries with "walnut" in 3 cases (advait, aeris, marl); chandra ("bent") | 0 in fingerprint features; hedge dropped in 3 ashford queries | Medium | Analyst (only partly noted by the reviewer) | Query rules or deterministic filter. Developer decision on species descriptors. |
| B6 | Accessory contamination | ashford (bolster in distinctive features and 2 queries) | 1 of 2 cases with prominent styling objects (alden handled correctly) | Medium to high | Confirmed (reviewer note) | Instruction "furniture, not styling" block. Deterministic exclusion of non-intrinsic features. |
| B7 | Uncertainty calibration: hidden or unverifiable facts labelled observed; decision-relevant unknowns missing | marl and alden (overconfident); advait, aeris, denby (no hidden-construction discussion) | 2 overconfident; 3 "insufficiently informative" | High for the 2; low for the 3 | Confirmed (reviews), with a rubric caveat | Instruction: certainty applies to structure and function; unknowns only when decision-relevant. Fix the rubric definition. |
| B8 | Query coverage: no broad query, missing synonyms, over-long or repetitive | All 10 lack a broad query. Synonyms missing in alden, ashford, chandra and advait | 10/10 no broad query; 4/10 narrow | High (hypothesis: hurts recall) | Confirmed (reviews). Instruction text causes the broad-query gap. | Deterministic broad-to-specific templates plus a category synonym table (Exp 3). Instruction query mix. |
| B9 | Error propagation: an uncertain or incorrect fingerprint element becomes a query constraint | marl (drawers ×3); ashford (bolster ×2, leather ×3); chandra ("dining" ×1) | 3 cases | High | marl confirmed; ashford partly; chandra analyst | Query builder that only uses `observed`, intrinsic features, plus an offline lint (Exp 3). Instruction grounding (Exp 1). |

**Positive findings to keep (regression targets):**
- Correct target choice in multi-object scenes (alden-side-table, ettrick-bed).
- Careful visible counts (denby-stool: "three visible").
- Relational descriptions in advait-three-seater and chandra-one-seater.
- Appropriately `inferred` materials.
- No brands or codes.
- No dimension claims.

---

## 6. Confirmed versus hypothesised problems

**Confirmed by records and reviews:**
- Unsupported drawer function, carried into queries (marl).
- Hidden leg count labelled observed (alden).
- Bolster promoted to a distinctive feature and used in queries (ashford).
- No broad query in any case.
- Synonym gaps (alden, chandra, advait, ashford).
- Seven partial critical features and three missed supporting features (by case, as listed).
- The certainty-label distribution: no `inferred` structure features.

**Recorded, but the classification needs adjudication:**
- Aeris-dining-table beam: partial, or a relationship error?
- Ashford-day-bed "leather" in queries: is it an unsupported assertion?
- Chandra-one-seater "dining" and "bent".
- "Walnut" descriptors in queries.

**Hypotheses (untested):**
1. *"Omit attributes that do not apply" suppresses defining absences.* Supported by the instruction text and by armless being missed or partial in 2 of 2 armless seating cases. Tested by Exp 2.
2. *The instruction's single query recipe ("combine the category with distinctive design features") causes the 0/10 broad-query result.* Strongly suggested by the text. Tested by Exp 1 (query mix) and Exp 3 (deterministic builder).
3. *Missing proportions and relationships are a reporting omission, not a perception failure.* The model was never asked for them. If explicit wording doesn't fix B3, perception is implicated.
4. *The certainty examples in the instructions only cover materials and dimensions, so the model treats certainty as a materials concept.* Consistent with all 14 `inferred` labels being style or material. Tested by Exp 1.
5. *Zero-reasoning runs are more error-prone.* n = 3, so this is not supported. Watch it, but don't act on it.
6. *Narrow 6–10-word queries reduce marketplace recall.* Plausible, but unmeasurable without retrieval testing.

---

## 7. Root-cause analysis

| Type | Problem | Evidence | Where it should be fixed |
| --- | --- | --- | --- |
| **1: Vision and description** | Proportions, relative position, connections and overhangs underspecified (B2, B3) | 7 partial critical features, 3 missed supporting features | **Instructions first.** We can't yet tell perception from reporting; Exp 2 separates them. Only if wording fails, test crops or reasoning effort, one variable at a time. |
| **1: Labelling** | Hidden or functional facts labelled observed (B4, B7) | marl, alden; 0 `inferred` structure features | **Instructions.** The existing `inferred` and `unknown` levels can already express this. |
| **2: Representation** | No way to mark a styling accessory | ashford | **Instructions** for now: exclude styling, or mark it `inferred`. A schema field only if Exp 1 shows instructions are not enough. |
| **2: Representation** | No idiom for an observed absence (`"None"` string) | denby | **Instructions:** "no armrests" as an observed value. No schema change needed. |
| **2: Representation** | One feature mixes the visible part and the inferred part ("Four … legs; the two front legs are visible") | alden | **Instructions:** split into a visible part and an inferred part. |
| **2: Representation** | Queries are free strings with no link to the features they rely on, so propagation can't be detected automatically | marl, ashford | **Deterministic query builder:** queries are generated *from* feature ids and certainty, so provenance comes by construction. |
| **2: Representation** | Spatial relationships | aeris (weak), but advait and chandra show relationships expressed well in text | **No scene graph.** The evidence shows text values can carry relationships; the gap is asking for them. |
| **3: Search generation** | No broad query; synonym gaps; hedge loss; accessory and function propagation (B8, B9) | 10/10, plus 4 synonym cases, plus 3 propagation cases | **Separate deterministic component** (category synonyms plus broad-to-specific templates, built only from observed intrinsic features). Keep Luna's queries as one input until retrieval data exists. |

**Should query generation stay inside the Luna call?** Short term, both should run:
- **Keep Luna's queries:** they hold useful visual vocabulary such as "fluted", "cradle style" and "sweeping apron".
- **Add a deterministic layer:** it guarantees broad and synonym coverage and can't introduce unsupported constraints.

The decision to remove queries from the model call should wait for retrieval measurements. Today there is no evidence about recall either way.

---

## 8. Implications for cross-source sourcing

- **Discovery is the gate.** Today, text queries are the only route to Alibaba candidates. Embeddings (SigLIP 2) and visual verification (GPT-6.1 Sol) can only rank what discovery returns. Query errors are therefore not recoverable later.
  - **Hypothesis:** long, specific queries and missing synonyms are more likely to reduce recall than wrong descriptions are.
- **False constraints are worse than omissions.** "Four drawer desk" or "leather chaise with bolster" can exclude true matches, or attract products that differ in function. An omitted overhang only weakens discrimination, which the image-based stages can partly recover.
- **Certainty labels will matter more at verification.** If Sol compares candidates attribute by attribute, an `observed` "drawers" or "four legs" could penalise a correct candidate. Labels need to be trustworthy before verification is built on them.
- **Category label versus marketplace vocabulary.** A correct taxonomy label (`chest_of_drawers`) doesn't guarantee marketplace terms (nightstand, bedside table). A synonym table belongs outside the vision model, where it can be tested and corrected.
- **Not addressed by this dataset:** lifestyle and room photographs with several items. This is likely the main real-world input (screenshots, social posts), and target selection there is untested.

---

## 9. Recommended priorities

In dependency order. Details, criteria and the backlog are in `P0-007-improvement-experiment-plan.md`.

1. **Experiment support in the tooling.**
   - Select a candidate instruction version explicitly (never by default).
   - Evaluate each arm against its own settings.
   - Produce a paired comparison report.
   - Clarify the rubric.
2. **Deterministic query builder plus offline query checks.** It runs on saved fingerprints with no paid requests (Exp 3).
3. **Instructions v2 candidate experiments.** The developer runs these:
   - Exp 1: grounding block.
   - Exp 2: geometry block.
   - Repeat runs, to measure noise.
4. **Conditional work, only if experiments justify it:**
   - a schema field for feature role (intrinsic or styling);
   - crops, or a reasoning-effort test.
5. **Later, dependent on authorised Alibaba access:** retrieval evaluation (Recall@K) of query strategies.
6. **Before shipping a revised configuration:** a small unseen hold-out set, annotated before inference.
