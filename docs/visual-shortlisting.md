# Visual shortlisting with SigLIP 2

How recorded Alibaba.com candidates are ranked by image similarity to the reference photograph, and how to read the result. Written for P1-002 on 2026-10-26.

```
saved GPT-6 Luna run (evals/local/predictions/<case>.json)  ─┐
private image mapping (evals/local/images.json)              ├─► pnpm shortlist:images --case <case>
candidate manifest + local images (evals/local/candidates/)  ─┘        │  validates, hashes, plans one image per listing
                                                                        ▼
                                          python -m vfsa_vision embed   (services/vision, local model, offline)
                                                                        │  JSON on stdout
                                                                        ▼
                         validated cosine similarities → VisualShortlist → evals/local/shortlists/<case>-<model>.{json,md}
```

The shortlist is a **retrieval-stage** result. It does not go through `SourcingPipeline` and does not create `VisualMatchAssessment` records; candidates stay "not assessed" until a detailed visual verifier exists.

## 1. Checkpoint

- **Default:** [`google/siglip2-base-patch16-384`](https://huggingface.co/google/siglip2-base-patch16-384) (768-dimensional image embeddings, 384×384 input, about 1.4 GB of fp32 weights). It is Google's official SigLIP 2 release, small enough to run quickly on a laptop GPU (Apple MPS) or CPU, and uses the same 384 px resolution as the larger model, so switching later changes capacity rather than input handling.
- **Optional:** [`google/siglip2-so400m-patch14-384`](https://huggingface.co/google/siglip2-so400m-patch14-384), the higher-capacity model named in the architecture plan. Not downloaded or tested yet.
- The model is loaded with the official `AutoProcessor` and `AutoModel` ([Transformers SigLIP 2 docs](https://huggingface.co/docs/transformers/model_doc/siglip2)). Only `google/siglip2-*` ids are accepted, and the loaded model type must be `siglip` or `siglip2`. Nothing switches checkpoints automatically.

## 2. Setup

See [services/vision/README.md](../services/vision/README.md) for the exact commands: a project-local virtual environment with pinned dependencies, and an explicit one-time model download into `services/vision/.cache/` (git-ignored). The shortlist command never downloads anything; if the checkpoint is not cached it fails with `model_not_cached`.

## 3. Running

```sh
pnpm shortlist:images --case ettrick-bed --dry-run      # inputs, images, plan and environment; no model run
pnpm shortlist:images --case ettrick-bed --top-k 4      # real local inference; saves the report
pnpm shortlist:images --case ettrick-bed --top-k 4 --json --no-save
```

Options: `--model`, `--revision` (require a specific commit), `--device auto|mps|cpu` (an explicit device is never replaced), `--output-dir`, and the same input-location options as `source:candidates`. Exit codes: `0` OK, `1` invalid input or evidence, `2` usage or missing input, `3` the embedding component failed (no scores are produced).

## 4. Which image is used (selection policy)

- **One image per listing.** Images with role `"primary"` are tried first, then the rest in manifest order. The first image that exists and decodes is used.
- **Fallback is recorded:** each shortlist entry marks `fallback: true` when the image used is not the listing's first choice, and lists every skipped image with its reason.
- **Never the best of several.** Scores are not maximised over a listing's images, so listings with more photos gain no advantage.
- **Remote image URLs are not fetched.** A listing with only remote URLs, or no images, is listed under `excluded` with the reason. It is never given a score.

### Evidence safety

- **Reference:** the photograph mapped to the case in `evals/local/images.json` is used only if its SHA-256 equals the image hash in the saved run record, so the embedding is of the same photograph GPT-6 Luna analysed.
- **Candidates:** only `localPath` images from a manifest that passes the existing `source:candidates` validation. They must resolve inside `<candidates folder>/<case-id>/`; symbolic links, a symlinked evidence folder, non-files and paths outside that folder stop the run.
- **Hand-off integrity:** TypeScript hashes every file it approves; Python re-reads each file (refusing symlinks), checks the hash before decoding, and aborts if it differs.
- **Decoding (Pillow):** PNG, JPEG, WebP and AVIF; size and pixel limits; EXIF orientation applied; transparency composited onto white; converted to RGB. Corrupted or unsupported files are rejected with a reason. Original files are never modified.

## 5. How similarity is computed

1. Reference and candidate images go through the same pretrained processor (for the Base checkpoint: bilinear resize to 384×384, rescale by 1/255, normalize with mean and std 0.5).
2. `model.get_image_features()` under `torch.inference_mode()`, fp32, gives the pooled image embedding.
3. Each embedding is L2-normalized in float64, and the cosine similarity with the reference is the dot product. Results must be finite and within [−1, 1] (tolerance 1e-4).
4. Ranking is by descending cosine, with ties broken by ascending listing id. TypeScript re-checks the order, the model id and revision, the reference hash, and that every selected image was offered with the hash offered.

## 6. Interpreting scores

- **What it is:** a raw cosine similarity between whole-image embeddings: a retrieval ranking signal, useful for ordering candidates for review.
- **What it is not:** a design match percentage, a calibrated probability or confidence, an exact-design verification, or evidence of the same product or manufacturer. It is never multiplied by 100 and never written into `designSimilarityIndex`, `confidence` or `classification`.
- **Compare within a run only.** Scores are relative to the other candidates scored with the same checkpoint and preprocessing. Absolute values are not comparable across checkpoints, and the gaps between candidates may be small.
- **Background matters.** The model sees the whole image (see limitations).

## 7. Provenance and reproducibility

Every shortlist records:
- the checkpoint id and the **resolved commit hash** of the cached snapshot (for example `f775b65a79762255128c981547af89addcfe0f88` for the Base model downloaded on 2026-10-26);
- architecture, embedding size and dtype;
- device and why it was chosen;
- processor settings;
- Python, PyTorch, Transformers and Pillow versions;
- reference and candidate image hashes;
- the selection policy, and the manifest capture time.

Pass `--revision <commit>` to require a specific snapshot. Reports are written to `evals/local/shortlists/<case>-<model name>.json` and `.md` (private, git-ignored). A rerun replaces only the file for the same case and checkpoint, and reports contain no local file paths.

## 8. Current limitations

- **Whole-image comparison:** the reference is a clean product photograph, while Alibaba candidate images often show furnished rooms, bedding and decor. Backgrounds, lighting and styling can raise or lower the cosine. There is no segmentation, cropping or background removal yet.
- **Aspect ratio:** the Base processor resizes to a square 384×384 without preserving aspect ratio, so non-square photos are slightly distorted.
- **One image per listing:** gallery views are not combined.
- **Remote URLs:** they are not fetched; only operator-saved local images can be used.
- **Small sample:** four candidates is a functional proof, not a benchmark. There is no labelled set yet to measure whether the shortlist keeps true matches near the top.
- **Harmless warning:** loading the checkpoint logs a Transformers warning about `bos_token_id`/`eos_token_id` in the text configuration. Only the image encoder is used.
- **MPS vs CPU:** results differ in about the 7th decimal place; ranking is unaffected in the Ettrick run.

## 9. Switching checkpoints

```sh
services/vision/.venv/bin/python -m vfsa_vision download --model google/siglip2-so400m-patch14-384   # explicit, several GB
pnpm shortlist:images --case ettrick-bed --model google/siglip2-so400m-patch14-384
```

The report is written to a separate file named after the checkpoint, so runs from different models never overwrite each other. Compare checkpoints on the same candidates only by rank order, not by raw score.

## 10. Feeding a detailed visual verifier

The shortlist is the input to the next stage:
- each entry keeps the real `CandidateListing` id, URL, title and supplier reference, the image used (manifest reference and hash), and `visualVerificationStatus: "not_assessed"`;
- the GPT-6.1 Sol verifier ([visual-verification.md](visual-verification.md)) compares the reference with each candidate image and produces `VisualMatchAssessment` records through the existing `VisualVerificationService` contract. For the first experiment it verifies every candidate, not only the top-K, and is never shown the shortlist;
- only that verifier may fill `designSimilarityIndex`, `confidence` and `classification`. The embedding cosine can be stored alongside as a retrieval signal, but is never converted into those fields.
