# Detailed visual verification with GPT-6.1 Sol

How a candidate photograph is compared with the reference photograph, how results are stored and reported, and how paid requests are controlled. Written for P1-003 on 2026-10-26.

**Status: implemented, awaiting the first live run.** No paid request has been made, so nothing here says anything about Sol's real accuracy on furniture.

## 1. Architecture

```
saved Luna fingerprint ─┐                     ┌─ reference photo (hash = saved run)
candidate manifest ─────┼─ pnpm verify:visual ┤
                        │                     └─ one local image per listing (shortlist evidence rules)
                        ▼
      OpenAIVisualVerificationService  (implements VisualVerificationService)
        for each listing, sequentially, within a PaidRequestBudget:
          OpenAIVisualVerificationClient → Responses API, gpt-6.1-sol, Structured Outputs
          raw output → Zod check → consistency check → VisualMatchAssessment (adapter sets provenance)
                        ▼
      evals/local/verifications/<case>/<listing>/<model>__<instructions>__<time>__<attempt>.json
                        ▼
      pnpm verify:visual --report  → report.json / report.md (saved records + saved SigLIP shortlist; no model call)
```

Code is in `apps/web/src/lib/sourcing/verification/openai/`:

| File | Contents |
|---|---|
| `instructions.ts` | Versioned rubric, plus the fingerprint context sent with each pair |
| `raw-response.ts` | Strict raw schema the model fills |
| `verification-client.ts` | Responses API client: one request, no retries, no tools, `store: false` |
| `mapping.ts` | Consistency rules and mapping into `VisualMatchAssessment` |
| `evidence.ts` | Loads images: hash re-check and structural validation |
| `openai-visual-verification.ts` | The service, the request budget and per-pair outcomes |
| `record.ts` | Private run records: schema, atomic writes, duplicate keys |
| `report.ts` | Offline comparison report |

Other pieces:
- **CLI:** `cli/verify-visual.ts`.
- **Composition root:** `pipeline/verified.ts`, which runs the existing `SourcingPipeline` with any `VisualVerificationService`.
- **Image structure checks:** `image-input/inspect.ts`.

### Responsibilities stay separate
- **Luna:** describes the reference.
- **Discovery:** imports candidates.
- **SigLIP 2:** ranks by whole-image embedding similarity.
- **Sol:** compares structure pair by pair.
- **Ranking:** a separate policy, not part of this milestone.

## 2. Why Sol comes after SigLIP 2

SigLIP 2 is cheap and local, but it compares whole images. On Ettrick it ranked the candidate with the closest headboard last, apparently because of room scenes and colour (see the P1-002 diagnostic). Sol is asked to compare specific structural features and to say what it cannot see.

For this first experiment, **every candidate is verified regardless of SigLIP rank**: no top-K filter and no cosine threshold. Sol is never shown cosines or ranks.

## 3. Model and request settings

- **Model:** [`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol), which supports image input, the Responses API and Structured Outputs.
  - Override with `--model` or `OPENAI_VISUAL_VERIFICATION_MODEL`.
  - It is never switched automatically. If Sol is unavailable, the run fails with `model_not_found` or `permission`.
- **Settings:**
  - image detail `high`
  - reasoning effort `medium`
  - `max_output_tokens` 6000, including reasoning (`--max-output-tokens`, 1000–32000)
  - timeout 180 s (`--timeout-ms`)
  - SDK `maxRetries: 0`, `store: false`, `tools: []`
- **Cost:** about $2 per million input tokens and $10 per million output tokens, per the model page on 2026-10-26.
  - Each pair sends two high-detail images.
  - Token usage, including reasoning tokens, is recorded for every response.

## 4. Image input and evidence rules

Images go through the same resolver as `shortlist:images`:
- **Reference:** only the photograph mapped in `evals/local/images.json`, and only if its SHA-256 equals the hash in the saved Luna run.
- **Candidates:** only `localPath` images confined to `<candidates>/<case>/`. Symlinks and traversal stop the run.
- **Image choice:** the same policy as the shortlist. The "primary" image is tried first, then the others in manifest order, and the first usable one is used. Remote URLs are never fetched.

Before any request, each file is:
1. read again, refusing symlinks;
2. hash-checked against the value approved earlier;
3. size-checked (10 MB);
4. structurally validated:
   - **PNG:** every chunk CRC, IHDR, IDAT and IEND;
   - **JPEG:** segment walk, frame header, end-of-image marker;
   - **WebP:** RIFF size and chunk header;
5. dimension-checked (16–12,000 px per side, at most 50 MP).

This is structural validation, not pixel decoding. Truncated and corrupted files are rejected; full decoding happens at the provider.

**AVIF** is rejected with an instruction to convert it locally. The current manifest schema doesn't allow `.avif` paths anyway.

Images are sent as base64 data URLs, unchanged. Base64 data never appears in logs or records.

## 5. What the model sees

| Sent | Never sent |
|---|---|
| The rubric (`instructions.ts`) | Listing titles, URLs and product ids |
| The reference image, labelled REFERENCE | Supplier names and claims |
| The candidate image, labelled CANDIDATE | Prices, MOQ and attributes |
| The fingerprint's category, structure, appearance and distinctive-feature observations, marked "may be wrong; verify against the reference image" | Operator notes and search queries |
| | SigLIP cosines or ranks |
| | Human judgements |
| | Other candidates or their results |

Tests assert these exclusions.

### Instruction versioning

`VISUAL_VERIFICATION_INSTRUCTIONS_VERSION` (currently `2026-10-26.1`) is stored in every record and in the duplicate key. Any change to the rubric, the prompt text or the fingerprint context must bump it. The report only uses records made with the current model and version.

## 6. Structured response

`raw-response.ts` uses the Structured Outputs subset: every field is required, with null for absence.

**Per image:**
- `reference_target` and `candidate_target`: `{identifiable, category, note}`
- `category_comparison`: `same_category`, `different_category` or `cannot_determine`

**`features` (up to 24), each with:**

| Field | Values |
|---|---|
| `feature` | Short name |
| `aspect` | `structural_geometry`, `silhouette_proportion` or `surface_appearance` |
| `importance` | `defining`, `supporting` or `minor` |
| `reference_observation`, `candidate_observation` | Text, or null when not visible |
| `comparison` | `match`, `partial_match`, `mismatch` or `not_comparable` |
| `evidence_basis` | `observed`, `inferred` or `not_visible` |
| `visibility_limitation` | Text, or null |
| `explanation` | One short sentence |

**Overall:**
- `visibility_limitations` and `uncertain_claims`
- `summary`
- `classification`: the existing domain enum
- `design_similarity_index`: integer, or null
- `confidence`: `low`, `medium` or `high`

### Consistency rules, enforced after the schema check

| Rule | Detail |
|---|---|
| Index | An integer from 0 to 100, or null |
| Null index | Null only with `insufficient_evidence`, and `insufficient_evidence` always has a null index |
| Index bounds by classification | `exact_visual_design` ≥ 80; `close_variant` ≥ 50; `similar_alternative` ≤ 85; `non_match` ≤ 50 |
| Unidentifiable target | Must be `insufficient_evidence` |
| Different categories | Must be `non_match` |
| `not_visible` features | Must be `not_comparable` |
| Compared features | Need both observations |
| Non-abstaining results | Need at least one compared feature |
| `exact_visual_design` | Needs a matching defining feature and no defining mismatch |

Output that is schema-valid but breaks these rules is saved as `invalid_output`, with the raw output kept for audit, and produces no assessment.

### Mapping to `VisualMatchAssessment`

The domain contract is unchanged.

| Assessment field | Source |
|---|---|
| `classification`, `confidence` | Explicit mapping from the raw enum to the domain enum |
| `designSimilarityIndex` | The checked index, or null |
| `supportingEvidence` | Match and partial-match features |
| `differences` | Mismatches |
| `unverifiableFeatures` | Not-comparable features, visibility limitations and uncertain claims |

- **Evidence descriptions** carry `[comparison; importance; aspect; basis]`, both observations, and the candidate image URI.
- **Set by the adapter, never by the model:**
  - assessment id;
  - reference, fingerprint and listing ids;
  - `assessedAt`;
  - `metadata` (`dataSource: "live"`, `method: "multimodal_model"`, the API-reported `modelId`, and notes with the instructions version and response id);
  - the image hashes in the record.
- **Validation:** the result is checked with `visualMatchAssessmentSchema`, and its listing and reference associations are checked.

## 7. Index, classification and confidence

**Design similarity index:** a qualitative 0–100 judgement of how similar the visible designs are. It is not a probability, not calibrated, and not proof of the same product or manufacturer. Rubric bands:

| Band | Meaning |
|---|---|
| 90–100 | Visually indistinguishable |
| 75–89 | Same design idea, minor differences |
| 50–74 | Clearly related, some defining features differ |
| 25–49 | Same category, loosely related style |
| 0–24 | Unrelated, or incomparable categories |

- **Not a cosine:** it is never derived from SigLIP cosine or from supplier data.
- **Abstaining:** a null index means the model abstained; it is never 0.

**Classification** uses the existing values: `exact_visual_design`, `close_variant`, `similar_alternative`, `non_match`, `insufficient_evidence`. "Exact" means the designs look the same, not the same SKU.

**Confidence** says how well the visible evidence supports the judgement, separately from similarity. A clearly visible mismatch can be high confidence; a close match with the defining parts hidden should be low.

## 8. Cost and request controls

- **Without `--live`, nothing is sent.** `--dry-run` is the default.
- **Paid runs need all of:** `--live`; an explicit selection (`--listing-id <id>` or `--all`); and `--max-paid-requests <n>`.
  - There is no default cap.
  - The cap may not exceed the number of selected listings.
  - If more requests are planned than the cap allows, nothing is sent.
- **Inside the service:** a `PaidRequestBudget` enforces the cap independently.
- **Ordering:** requests run one at a time, in manifest order.
- **No retries and no fallback model.**
- **Fatal errors stop the batch:** after an `authentication`, `permission`, `model_not_found` or `rate_limit` error, the remaining listings are not sent.
- **Duplicate protection:**
  - **Same pair:** a pair with an existing record for the same case, listing, both image hashes, model, instructions, detail and effort is skipped.
  - **Every status counts:** succeeded, failed and interrupted ("requested") records are all skipped.
  - **Repeating:** `--rerun` requests again. New records never overwrite old ones.
- **Interruption safety:** a `requested` record is written atomically before each request. If it cannot be written, the request is not sent (exit 4). The final state then replaces it atomically. An interrupted run leaves `requested` records, which are treated as possibly charged.
- **Persistence failure after a response:** the full record (no image data) is printed to stderr for recovery (exit 4).

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Invalid input or evidence |
| 2 | Usage error or missing input |
| 3 | At least one request did not produce a valid assessment |
| 4 | A record could not be saved |

## 9. Workflow

```sh
# 1. Dry run: validates everything and prints the plan, hashes and API-key presence. Sends nothing.
pnpm verify:visual --case ettrick-bed --dry-run

# 2. One paid request (candidate 001):
pnpm verify:visual --case ettrick-bed --listing-id alibaba-product-1601706922584 --live --max-paid-requests 1

# 3. All four candidates (at most four paid requests; already-recorded pairs are skipped):
pnpm verify:visual --case ettrick-bed --all --live --max-paid-requests 4

# 4. Offline comparison report: saved records + saved SigLIP shortlist. Sends nothing.
pnpm verify:visual --case ettrick-bed --report
```

**If you ran step 2 first:** step 3 skips candidate 001 and plans three requests, which a cap of 4 allows. Use `--max-paid-requests 3` to be exact.

### Partial failures

- **Where to look:** every attempt has its own record under `evals/local/verifications/<case>/<listing>/`.
- **Before repeating a failed pair,** read its record (`error.category`): an incomplete response may need a higher `--max-output-tokens`, and an access error needs account changes.
- **To repeat it:** run `--listing-id <id> --live --max-paid-requests 1 --rerun`.
- **In the report:** unsuccessful and unverified candidates stay visible, unranked and never scored 0.

### Report

`evals/local/verifications/<case>/report.json` and `report.md` list every manifest listing with:
- the verification rank: assessed candidates by descending index, ties by listing id;
- Sol's index, classification and confidence, with key structural matches and mismatches and evidence gaps;
- the record status and attempt count;
- the SigLIP rank and cosine from the saved shortlist, side by side and never combined;
- the supplier name, for identification only.

## 10. Limitations

- **Single view:** each candidate is judged from one photograph. Angled views, bedding and room styling can hide defining parts. The rubric asks the model to say so, but it cannot see what isn't photographed.
- **Model-derived index:** the index and confidence are the model's own judgements, with no calibration.
- **Small sample:** four candidates is a functional test, not a benchmark.
- **Fallible context:** the reference observations come from Luna and may be wrong. The model is told to check them against the image.
- **Structural decode only:** image validation is structural; full decoding is done by the provider.
- **No production ranking:** there is no production ranking policy yet, and nothing combines SigLIP, Sol and supplier signals.

## 11. Connection to the sourcing pipeline

- **Integration point:** `OpenAIVisualVerificationService` implements the existing `VisualVerificationService`, and `createVerifiedCuratedSourcingPipeline` runs the unchanged `SourcingPipeline` with it, including its integrity checks.
- **Unassessed by default:** listings without a usable image, beyond the budget, or with a failed request get no assessment and stay unassessed.
- **Never paid by accident:** no existing command (`source:candidates`, `shortlist:images`, `demo:pipeline`) creates a paid client. The synthetic and "unassessed" verification services are unchanged.
- **Human judgements stay separate:** they are not part of this code. They should be compared with Sol's saved results in a separate review after the live run.
