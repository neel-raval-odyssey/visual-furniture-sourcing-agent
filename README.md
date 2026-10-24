# Visual Furniture Sourcing Agent

An AI-powered furniture sourcing application. Given a reference photo of a piece of furniture from any source, it discovers candidate Alibaba listings, compares design similarity, and returns ranked products with seller information.

> Status: early development.
> - **Real:** image understanding (GPT-6 Luna), usable from a local CLI.
> - **Synthetic stubs:** discovery and visual verification.
> - **Provisional:** ranking.
> - **Not available yet:** live end-to-end Alibaba sourcing, and any upload UI.

## Requirements

- Node.js ≥ 22 (required by the OpenAI SDK; see `.nvmrc`)
- pnpm 10 (`corepack enable` will pick up the version from `package.json`)
- Python 3.12+ (later, for the embedding service only)

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
| `pnpm build`     | Production build of the web app             |
| `pnpm start`     | Serve the production build                  |
| `pnpm lint`      | Run ESLint                                  |
| `pnpm typecheck` | Generate Next.js route types and run `tsc`  |
| `pnpm test`      | Run unit tests (Vitest)                     |
| `pnpm demo:pipeline` | Run one synthetic sourcing workflow and print a summary (mock data only) |
| `pnpm analyze:image --file <path>` | Validate a local photo and show the request settings (dry run, no API call). Add `--live` for one paid GPT-6 Luna request; `--case <id> --output <file.json>` saves an evaluation record |
| `pnpm eval:images` | Offline image-understanding evaluation: reads saved runs and reviews and writes `report.json` and `report.md` (see [evals/image-understanding](evals/image-understanding/README.md)) |
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

## Repository layout

```
apps/web/      Next.js app (App Router, TypeScript, Tailwind CSS, ESLint)
evals/         Shareable evaluation datasets and guides (evals/local/ is private and git-ignored)
services/      Future backend services (Python embedding service)
docs/          Architecture and evaluation documents
AGENTS.md      Rules for AI agents working in this repo
```

## Architecture summary

1. **Image understanding** — a vision model (GPT-6 Luna, implemented) describes the reference furniture: category, materials, style and distinguishing features.
2. **Candidate discovery** — an adapter queries Alibaba through an authorized integration (not yet confirmed) using the extracted attributes.
3. **Visual comparison** — SigLIP 2 (So400m Patch14-384) embeddings shortlist candidates by similarity; a detailed model (proposed: GPT-6.1 Sol) compares the top candidates.
4. **Seller intelligence** — seller attributes from listing data are attached to each candidate.
5. **Results** — ranked products with similarity explanations and seller information.

Planned infrastructure: PostgreSQL, S3-compatible object storage, and a Python embedding service. See [docs/architecture.md](docs/architecture.md) and [docs/evaluation-plan.md](docs/evaluation-plan.md).
