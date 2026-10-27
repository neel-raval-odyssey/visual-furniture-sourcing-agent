# Visual Furniture Sourcing Agent

An AI-powered furniture sourcing application. Given a reference photo of a piece of furniture from any source, it discovers candidate Alibaba listings, compares design similarity, and returns ranked products with seller information.

> Status: early development.
> - **Real:** image understanding (GPT-6 Luna), usable from a local CLI.
> - **Implemented, awaiting first authorized live run:** automated Alibaba.com discovery through a third-party provider (Apify Actor `scrapewise/alibaba-com-scraper`, not an official Alibaba.com API; `pnpm discover:marketplace`).
> - **Real, operator-assisted:** Alibaba.com candidate intake. A person finds candidates with Alibaba Lens or Alibaba.com search and records them in a private manifest; the app imports them and searches nothing itself.
> - **Real, local:** visual shortlisting. SigLIP 2 image embeddings rank recorded candidates by cosine similarity to the reference (a retrieval signal, not a verified match).
> - **Real:** detailed visual verification with GPT-6.1 Sol (`pnpm verify:visual`; paid requests only with `--live` and an explicit cap), run on the four Ettrick candidates.
> - **Real, offline:** end-to-end orchestration (`pnpm source:auto`) from a saved reference to a consolidated sourcing result.
> - **Synthetic stubs:** mock discovery fixtures and mock visual verification. Real candidates without a Sol result are reported as "not assessed".
> - **Provisional:** ranking.
> - **Real, local:** a web interface for saved sourcing results — a plain-language simple view plus an advanced workspace with offline runs and private photo staging (`pnpm dev:local`).
> - **Not available yet:** live end-to-end Alibaba sourcing, and analysis of newly uploaded photos.

## Requirements

- Node.js ≥ 22 (required by the OpenAI SDK; see `.nvmrc`)
- pnpm 10 (`corepack enable` will pick up the version from `package.json`)
- Python 3.11+ (3.13 tested) for the local SigLIP 2 component in `services/vision` only

## Getting started

```sh
pnpm install
pnpm dev        # http://localhost:3000
```

## Environment variables

`.env.example` at the repository root lists the environment variables the project uses. New variables are added there as integrations are implemented.

| Variable | Needed for | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | `pnpm analyze:image --live` | — |
| `OPENAI_IMAGE_UNDERSTANDING_MODEL` | Image analysis | `gpt-6-luna` |

Put real values in your own private env file. Next.js loads env files from its app directory, not from the repository root, so variables for the web app go in `apps/web/.env.local`. All `.env` and `.env.*` files except `.env.example` are git-ignored. Never commit real credentials.

## Commands

Run from the repository root:

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `pnpm dev`       | Start the Next.js dev server                |
| `pnpm dev:local` | Start the local sourcing interface (private data enabled, loopback only): simple view at http://localhost:3000/sourcing, advanced workspace at `/sourcing/workspace` |
| `pnpm build`     | Production build of the web app             |
| `pnpm start`     | Serve the production build                  |
| `pnpm lint`      | Run ESLint                                  |
| `pnpm typecheck` | Generate Next.js route types and run `tsc`  |
| `pnpm test`      | Run unit tests (Vitest)                     |
| `pnpm demo:pipeline` | Run one synthetic sourcing workflow and print a summary (mock data only) |
| `pnpm analyze:image --file <path>` | Validate a local photo and show the request settings (dry run, no API call). Add `--live` for one paid GPT-6 Luna request; `--case <id> --output <file.json>` saves an evaluation record |
| `pnpm eval:images` | Offline image-understanding evaluation: reads saved runs and reviews and writes `report.json` and `report.md` (see [evals/image-understanding](evals/image-understanding/README.md)) |
| `pnpm source:candidates --case <id> --prepare\|--validate\|--run` | Operator-assisted Alibaba.com candidate intake from a saved fingerprint (offline; see [docs/alibaba-candidate-intake.md](docs/alibaba-candidate-intake.md)) |
| `pnpm shortlist:images --case <id> [--dry-run] [--top-k <n>]` | Rank a case's recorded candidates by SigLIP 2 image-embedding cosine similarity (local model; see [docs/visual-shortlisting.md](docs/visual-shortlisting.md)) |
| `pnpm verify:visual --case <id> [--dry-run\|--report]` | Detailed visual verification with GPT-6.1 Sol. Dry run by default; `--live` with `--listing-id`/`--all` and `--max-paid-requests` sends paid requests; `--report` compares saved results offline (see [docs/visual-verification.md](docs/visual-verification.md)) |
| `pnpm discover:marketplace --case <id> --provider apify --mode image\|keyword\|hybrid` | Automated candidate discovery via a third-party provider. Dry run by default; `--live` needs explicit caps and authorizations; `--resume`, `--replay` (offline), `--fetch-images` (see [docs/automated-marketplace-discovery.md](docs/automated-marketplace-discovery.md)) |
| `pnpm source:auto --case <id> --source curated\|provider-run\|provider-live --plan\|--run --offline` | Offline orchestration of the whole workflow into one sourcing result; also `--resume <run id> --offline` (see [docs/automated-sourcing-orchestration.md](docs/automated-sourcing-orchestration.md)) |
| `pnpm check`     | Lint, typecheck, test and build in sequence |

## Analysing a local furniture photo

```sh
# 1. Put your key in apps/web/.env.local (git-ignored):
#    OPENAI_API_KEY=...
# 2. Dry run: validates the file and prints the settings. Nothing is sent.
pnpm analyze:image --file "/path/to/chair.jpg"
# 3. Live: sends exactly one request to OpenAI (paid).
pnpm analyze:image --file "/path/to/chair.jpg" --live
#    Add --json for machine-readable output.
```

- **Input:**
  - JPEG, PNG or WebP, up to 10 MB. The format is detected from the file's content, not its extension.
  - Relative paths are resolved from the directory you run `pnpm` in.
  - The image bytes are sent unchanged as a base64 data URL with `detail: "high"`. They are not uploaded to storage, copied into the repo or logged.
- **Request:**
  - Responses API with Structured Outputs, reasoning effort `low`, max 4096 output tokens, 60 s timeout.
  - **No automatic retries**, `store: false`, no tools.
- **Output:**
  - Category and subtype, observed structure and appearance, inferred and unknown attributes, distinctive features, search queries, provenance and token usage.
  - The model output is not verified; inferred attributes are labelled as such.
- **Exit codes:** `0` success; `1` analysis failed (e.g. no furniture found, refusal, API error); `2` usage, input or configuration error.
- **Common errors:**
  - `OPENAI_API_KEY is not set`: add it to `apps/web/.env.local`.
  - `[authentication]` (401): invalid key.
  - `[permission]` (403) or `[model_not_found]` (404): the key's project has no access to the model.
  - `[rate_limit]` (429): rate limit or quota exceeded.
  - `[bad_request]` (400): e.g. the image was rejected by the API.
  - `No fingerprint produced`: the model reported no furniture, an ambiguous target or an unreadable image.

## Importing Alibaba.com candidates for a reference

No authorized Alibaba.com search API is available to us, so candidates are found by hand and imported. This uses no OpenAI request and no network.

```sh
pnpm source:candidates --case ettrick-bed --prepare    # search handoff + blank evals/local/candidates/ettrick-bed.json
# Search with Alibaba Lens or Alibaba.com, then record listings in the manifest.
pnpm source:candidates --case ettrick-bed --validate   # offline validation
pnpm source:candidates --case ettrick-bed --run        # normalized candidates and suppliers; add --json for full output
```

- **Synthetic sample:** add `--synthetic --predictions evals/image-understanding/synthetic/predictions --candidates evals/candidates/synthetic` and use case `syn-bed-001`.
- **Detailed visual verification is not implemented yet:** every imported candidate is reported as "not assessed".

## Using the web workspace

A local Next.js interface over the saved sourcing records, in two layers over the same data:

- **Simple view** (`/sourcing`, the default): "Find furniture that looks like this." Start → Results → Compare designs for the saved example, in plain language, with the original Alibaba listings. Uploading a photo only saves it for later analysis.
- **Advanced workspace** (`/sourcing/workspace`): every reference and fingerprint, run history and progress, SigLIP and Sol results, full evidence, provenance and offline runs from saved evidence.

See [docs/visual-sourcing-web-experience.md](docs/visual-sourcing-web-experience.md).

```sh
pnpm dev:local     # local-only: VFSA_LOCAL_SOURCING_UI=1, bound to 127.0.0.1
# open http://localhost:3000/sourcing            (simple view)
#      http://localhost:3000/sourcing/workspace  (advanced workspace)
```

It makes no marketplace or paid model requests. Private data is never served by a production build.

## Running the whole sourcing workflow

`pnpm source:auto` composes the stages for one case: the saved fingerprint, candidates (curated manifest or a saved discovery run), image checks, SigLIP 2 shortlist (reused or computed locally), and saved Sol assessments, into one result. It runs offline only. See [docs/automated-sourcing-orchestration.md](docs/automated-sourcing-orchestration.md).

```sh
pnpm source:auto --case ettrick-bed --source curated --plan            # checks and decisions; writes nothing
pnpm source:auto --case ettrick-bed --source curated --run --offline   # evals/local/sourcing-runs/ettrick-bed/<run id>/result.md
```

## Discovering candidates automatically

Searches Alibaba.com through a configured third-party provider and saves a private candidate manifest that the existing commands read with `--candidates <run folder>`. Review the access and data-use limitations in [docs/automated-marketplace-discovery.md](docs/automated-marketplace-discovery.md) before any live run.

```sh
pnpm discover:marketplace --case ettrick-bed --provider apify --mode image --dry-run     # plan only; nothing sent
pnpm discover:marketplace --case ettrick-bed --provider apify --mode keyword --dry-run
```

## Shortlisting candidates by image similarity

Needs the Python environment and a one-time model download ([services/vision/README.md](services/vision/README.md)). Inference runs locally; nothing is fetched or sent anywhere.

```sh
pnpm shortlist:images --case ettrick-bed --dry-run   # check inputs, images and environment; no model run
pnpm shortlist:images --case ettrick-bed --top-k 4   # embed, rank, save evals/local/shortlists/ettrick-bed-siglip2-base-patch16-384.{json,md}
```

Scores are raw cosine similarities between whole-image embeddings. They order candidates for review; they are not confidence, a match percentage or a verification.

## Verifying candidates with GPT-6.1 Sol

Compares the reference photo with each candidate photo, one pair per request, and records structural matches, mismatches and what could not be seen. Nothing is sent without `--live`.

```sh
pnpm verify:visual --case ettrick-bed --dry-run                                                       # plan, hashes, API key presence; no request
pnpm verify:visual --case ettrick-bed --listing-id alibaba-product-1601706922584 --live --max-paid-requests 1
pnpm verify:visual --case ettrick-bed --all --live --max-paid-requests 4                              # never retries; skips recorded pairs
pnpm verify:visual --case ettrick-bed --report                                                        # offline: Sol results beside SigLIP ranks
```

## Repository layout

```
apps/web/      Next.js app (App Router, TypeScript, Tailwind CSS, ESLint)
evals/         Shareable evaluation datasets and guides (evals/local/ is private and git-ignored)
services/      Python components (services/vision: local SigLIP 2 embeddings)
docs/          Architecture and evaluation documents
AGENTS.md      Rules for AI agents working in this repo
```

## Architecture summary

1. **Image understanding** — a vision model (GPT-6 Luna, implemented) describes the reference furniture: category, materials, style and distinguishing features.
2. **Candidate discovery** — an `AlibabaDiscoveryAdapter`. Candidates are operator-assisted (found on Alibaba.com by a person and imported) or discovered automatically through a third-party provider (Apify Actor; not an official Alibaba.com API; live use pending an access decision).
3. **Visual comparison** — SigLIP 2 image embeddings shortlist candidates by cosine similarity (implemented locally, Base Patch16-384 by default); GPT-6.1 Sol compares reference and candidate photos pairwise and produces structured assessments (implemented; first live run pending).
4. **Seller intelligence** — seller attributes from listing data are attached to each candidate.
5. **Results** — ranked products with similarity explanations and seller information.

Planned infrastructure: PostgreSQL and S3-compatible object storage. See [docs/architecture.md](docs/architecture.md) and [docs/evaluation-plan.md](docs/evaluation-plan.md).
