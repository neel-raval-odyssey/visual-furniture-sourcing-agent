# Review guide

Create the review file with `pnpm eval:images --init-review <case-id>`. Then open the original photograph, the run record (`evals/local/predictions/<case-id>.json`) and the case in `dataset.json`, and fill in the JSON as described below. Judge **meaning**, not wording: "arched vertical panels" and "rounded-arch slats" describe the same feature.

Only reviews with `"status": "complete"` count. Anything left as `not_reviewed` or `null` is excluded from denominators, so leave items unjudged rather than guessing.

## A. Primary object — `objectSelection`
| Value | Use when |
| --- | --- |
| `correct` | The model described the intended furniture item |
| `wrong_object` | It described a different item (e.g. the bedside table) |
| `genuinely_ambiguous` | Several items are equally plausible subjects |
| `not_applicable` | Non-furniture image or no fingerprint |
| `not_reviewed` | Not judged yet |

## B. Expected features — `features[]`
For each expected feature id from the dataset:

| `judgement` | Meaning |
| --- | --- |
| `captured` | Clearly described, with matching geometry |
| `partial` | Mentioned but incomplete or vague (e.g. "panels" without the arches) |
| `missed` | Not mentioned |
| `contradicted` | Described incorrectly (e.g. "straight" for an arched top) |
| `not_reviewed` | Not judged yet |

Add a short `note` when the judgement is not obvious.

## C. Unsupported assertions — `unsupportedAssertions[]`
Quote each problematic claim exactly as the model wrote it in `claim`, and add a short `explanation`. Set `type` to one of:
- `not_visible`: describes something that cannot be seen in the photo.
- `too_specific`: more precise than the evidence allows.
- `incorrect_geometry`: wrong shape, count or arrangement.
- `overconfident_material_or_dimension`: a material or dimension stated as fact, e.g. "solid walnut" or "160 cm wide".

## D. Uncertainty — `uncertainty.judgement`
| Value | Meaning |
| --- | --- |
| `appropriate` | Hidden or unverifiable details are marked `unknown`/`inferred` with sensible rationale |
| `overconfident` | Unverifiable details are presented as `observed` |
| `insufficiently_informative` | Everything is hedged; useful visible details are missing |
| `not_applicable` / `not_reviewed` | No fingerprint, or not judged yet |

## E. Search queries — `searchQueries`
- **`rating`:** a score from 1 to 5.
  - 1: no use for sourcing.
  - 3: right category, but generic.
  - 5: category plus the most distinctive design terms, with useful variations.
- **Flags:** answer `true`, `false` or `null` for each:
  - `broadCategoryQueryPresent`
  - `distinctiveTermsIncluded`
  - `excessivelyNarrow`
  - `irrelevantOrFabricatedTerms` (brands, model numbers, invented codes)
  - `exploresAlternatives`

These are preliminary judgements. They do not measure whether a marketplace search would succeed.

## F. Notes and tags
- **`failureTags`:** any that apply, from `wrong_object`, `wrong_category`, `missed_distinctive_feature`, `incorrect_geometry`, `hallucinated_detail`, `overconfident_material`, `vague_description`, `poor_search_queries`, `incorrect_rejection` and `other`.
- **`notes`:** free text describing important failures or good observations.
- **To finish:** set `status` to `"complete"`, `reviewer` to your name or initials, and `reviewedAt` to the current ISO time (e.g. `2026-10-25T14:30:00Z`).
