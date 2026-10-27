# services/vision

Local SigLIP 2 image embeddings and cosine similarity for the visual shortlist (`pnpm shortlist:images`). A bounded command-line component: no server, worker or database. Design, interpretation and limitations are in [docs/visual-shortlisting.md](../../docs/visual-shortlisting.md).

## Layout

```
vfsa_vision/
  images.py      safe file reading, hash check, decoding (PNG, JPEG, WebP, AVIF), EXIF orientation, RGB
  similarity.py  L2 normalization, cosine similarity, deterministic rank key (pure Python)
  protocol.py    strict validation of the JSON request
  model.py       checkpoint resolution (cache only), device selection, SigLIP 2 image embeddings
  cli.py         `embed`, `environment` and `download` commands
tests/           pytest suite: synthetic images, mocked model, network blocked
```

## Setup (macOS Apple silicon or CPU)

Tested with Python 3.13.2 on macOS (Apple M2 Max). Everything stays inside this folder; no global packages are changed.

```sh
cd services/vision
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-dev.txt   # or requirements.txt without pytest
```

### Download the model (explicit, one time, network)

```sh
.venv/bin/python -m vfsa_vision download --model google/siglip2-base-patch16-384
# prints {"status": "ok", "model": {"id": "...", "revision": "<commit hash>"}}
```

- **Where it goes:** weights (about 1.4 GB for Base) go to `services/vision/.cache/huggingface/`, which is git-ignored.
- **What is fetched:** only config, tokenizer and `*.safetensors` files.
- **Pinning a version:** add `--revision <commit>`.
- **No downloads at run time:** this is the only command that uses the network. `embed` and `environment` run with `HF_HUB_OFFLINE=1` and `local_files_only=True`.

### Check the environment (no weights loaded)

```sh
.venv/bin/python -m vfsa_vision environment
```

Reports:
- Python, PyTorch and Transformers versions;
- AVIF and WebP support;
- the device `auto` would pick, and why;
- whether the checkpoint is cached, and its revision.

`pnpm shortlist:images --dry-run` runs this check.

### Tests

```sh
.venv/bin/python -m pytest
```

No model weights are needed; network connections fail the tests.

## Devices

- **`auto` (default):** uses MPS when PyTorch reports it available, otherwise CPU. The reason is recorded either way, for example "this PyTorch build has no MPS support".
- **`--device mps`:** fails with `device_unavailable` when MPS cannot be used, rather than silently using CPU.
- **`--device cpu`:** always CPU.
- **Precision:** inference is fp32 on every device.

## Protocol

`python -m vfsa_vision embed` reads one JSON request on stdin and writes one JSON document on stdout. Diagnostics go to stderr. The TypeScript side is in `apps/web/src/lib/sourcing/shortlisting/protocol.ts`.

**Request:**
```json
{
  "protocol": "vfsa-image-similarity", "protocolVersion": 1,
  "model": { "id": "google/siglip2-base-patch16-384", "revision": null },
  "device": "auto",
  "reference": { "id": "<reference id>", "path": "/abs/path", "sha256": "<hex>" },
  "groups": [ { "id": "<listing id>", "images": [ { "ref": "<manifest localPath>", "path": "/abs/path", "sha256": "<hex>" } ] } ]
}
```

**Response:** `status: "ok"`, plus:
- `model`: id, resolved `revision`, architecture, `embeddingDim`, dtype;
- `device`, `preprocessing`, `runtime`, `reference`;
- `groups`, sorted by descending `embeddingCosineSimilarity` with ties broken by id. Each group is either `embedded`, with the selected image and any rejected ones, or `no_usable_image`.

**On failure:** `status: "error"` with `{code, message}`, and a non-zero exit code:

| Exit code | Meaning |
|---|---|
| 1 | Image problem |
| 2 | Invalid request |
| 3 | Model or device unavailable |
| 4 | Invalid embeddings, or internal error |

## Pinned dependencies

`requirements.txt` pins `torch 2.14.1`, `transformers 5.20.2`, `huggingface_hub 2.3.0`, `safetensors 0.8.0`, `tokenizers 0.23.3`, `pillow 13.0.0` (with AVIF), `numpy 2.5.4`. `requirements-dev.txt` adds `pytest 9.1.1`.
