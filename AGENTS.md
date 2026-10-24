# AGENTS.md

Shared project rules for any developer or coding agent working in this repository.

## Scope

- Work only inside this project directory.
- Make changes only for the assigned task. Do not start the next task automatically.
- Do not deploy, connect external services, use API keys, or create infrastructure unless the task explicitly requires it.
- Never commit real credentials. Document required environment variables in `.env.example`.

## Alibaba integration

- Alibaba discovery must go through an adapter and only use a confirmed, authorized integration (official API or approved partner). No scraping.

## Tooling

- Package manager: **pnpm** (workspace at repo root). Do not use npm or yarn.
- Frontend: Next.js (App Router), TypeScript (strict), Tailwind CSS, ESLint — in `apps/web`.
- Unit tests: Vitest, colocated as `*.test.ts` next to the code under test.
- Python services live in `services/` and are not part of the pnpm workspace.

## Before reporting a task done

Run from the repo root and make sure all pass:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## Reporting

Report clearly: what changed, how it was tested, and what remains incomplete or undecided. Do not invent benchmark or evaluation results.
