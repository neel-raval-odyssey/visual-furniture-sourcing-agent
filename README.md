# Visual Furniture Sourcing Agent

An AI-powered furniture sourcing application. Given a reference photo of a piece of furniture from any source, it discovers candidate Alibaba listings, compares design similarity, and returns ranked products with seller information.

> Status: repository bootstrap (P0-001). Only a placeholder web page exists; no image upload, AI or Alibaba integration is implemented yet.

## Requirements

- Node.js ≥ 20.9 (22 LTS recommended, see `.nvmrc`)
- pnpm 10 (`corepack enable` will pick up the version from `package.json`)
- Python 3.12+ (later, for the embedding service only)

## Getting started

```sh
pnpm install
pnpm dev        # http://localhost:3000
```

## Environment variables

`.env.example` at the repository root lists the environment variables the project needs. None are needed yet; variables will be added there as integrations are implemented.

When configuration is needed, create your own private env file. Next.js loads env files from its app directory, not from the repository root, so variables for the web app go in `apps/web/.env.local`. All `.env` and `.env.*` files except `.env.example` are git-ignored. Never commit real credentials.

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
| `pnpm check`     | Lint, typecheck, test and build in sequence |

## Repository layout

```
apps/web/      Next.js app (App Router, TypeScript, Tailwind CSS, ESLint)
services/      Future backend services (Python embedding service)
docs/          Architecture and evaluation documents
AGENTS.md      Rules for AI agents working in this repo
```

## Architecture summary

1. **Image understanding** — a vision model (proposed: GPT-6 Luna) describes the reference furniture: category, materials, style and distinguishing features.
2. **Candidate discovery** — an adapter queries Alibaba through an authorized integration (not yet confirmed) using the extracted attributes.
3. **Visual comparison** — SigLIP 2 (So400m Patch14-384) embeddings shortlist candidates by similarity; a detailed model (proposed: GPT-6.1 Sol) compares the top candidates.
4. **Seller intelligence** — seller attributes from listing data are attached to each candidate.
5. **Results** — ranked products with similarity explanations and seller information.

Planned infrastructure: PostgreSQL, S3-compatible object storage, and a Python embedding service. See [docs/architecture.md](docs/architecture.md) and [docs/evaluation-plan.md](docs/evaluation-plan.md).
