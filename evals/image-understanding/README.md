# Image-understanding evaluation

Measures how well the image-understanding stage (GPT-6 Luna, instructions `2026-10-24.1`) describes furniture photographs. It does **not** measure furniture matching or marketplace retrieval.

## Files

| Path | Shared? | Contents |
| --- | --- | --- |
| `evals/image-understanding/dataset.json` | yes | Cases and human reference annotations; baseline settings |
| `evals/image-understanding/review-template.md` | yes | How to fill in a review |
| `evals/image-understanding/local-images.example.json` | yes | Format of the private image mapping |
| `evals/image-understanding/synthetic/` | yes | **Synthetic** fixtures for testing the tooling. Never benchmark data. |
| `evals/local/images.json` | **no** (git-ignored) | Your case id → local image path mapping |
| `evals/local/predictions/` | **no** | Run records saved by `analyze:image --output` |
| `evals/local/reviews/` | **no** | Your review records |
| `evals/local/reports/` | **no** | Generated `report.json` / `report.md` |

Photographs are never committed. A colleague uses the same `dataset.json` with their own copies of the images. Setting `imageSha256` on a case lets `--images` confirm they have the same file.

## Baseline

The dataset pins model `gpt-6-luna`, instructions `2026-10-24.1`, image detail `high`, reasoning `low` and 4096 max output tokens. These must stay unchanged while the baseline is collected. Otherwise results from different settings get mixed and can't be compared. The evaluator excludes runs with other settings and lists them in the report.

## Workflow (human-controlled)

1. **Define a case** in `dataset.json`: a new `id`, `group`, `conditions`, `source` and the expected outcome.
   - For furniture cases, add critical and supporting features.
   - Use `annotationStatus: "draft"` until annotations are complete.
2. **Map the image locally** in `evals/local/images.json` (copy `local-images.example.json`).
3. **Dry run** (free, nothing is sent):
   ```sh
   pnpm analyze:image --file "/path/to/photo.jpg" --case <case-id> --output evals/local/predictions/<case-id>.json
   ```
4. **Live run** (one paid request; only when you decide to):
   ```sh
   pnpm analyze:image --file "/path/to/photo.jpg" --live --case <case-id> --output evals/local/predictions/<case-id>.json
   ```
   - Exit code `1` with a `not_identified` record is the expected result for a correctly rejected image.
   - Existing record files are never overwritten. Use a new file name, e.g. `<case-id>-2.json`; the latest run per case is used.
5. **Review** the photo next to the result:
   ```sh
   pnpm eval:images --init-review <case-id>   # writes evals/local/reviews/<case-id>.json
   ```
   Fill it in using `review-template.md`, then set `status` to `"complete"` along with `reviewer` and `reviewedAt`.
6. **Report** (offline, no API calls):
   ```sh
   pnpm eval:images --images evals/local/images.json
   ```
   Reports are written to `evals/local/reports/`. Add `--force` to replace earlier reports.

## Reading results

- Every rate is shown as `numerator / denominator`, along with what the denominator counts.
- **Coverage gaps are shown, not hidden:** missing runs, incomplete reviews and unusable files are listed in "Missing evaluations".
- **API failures** (rate limit, timeout, authentication) are counted separately and excluded from outcome accuracy.
- **No combined score:** identification, structural coverage, uncertainty and query quality are reported separately, with no overall percentage.
- **Small samples:** with fewer than 5 usable predictions, the report says that conclusions are limited.
- **Synthetic runs** (dataset `purpose: "tooling_test"` or `dataSource: "mock"`) are labelled SYNTHETIC throughout.
- **Search-query ratings** are preliminary human judgements, not marketplace retrieval results.

## Try the tooling on synthetic data

```sh
pnpm eval:images \
  --dataset evals/image-understanding/synthetic/dataset.json \
  --predictions evals/image-understanding/synthetic/predictions \
  --reviews evals/image-understanding/synthetic/reviews \
  --output evals/local/reports/synthetic
```
