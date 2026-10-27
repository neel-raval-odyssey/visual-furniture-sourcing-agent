# Automated sourcing orchestration

How `pnpm source:auto` turns a saved reference into one consolidated sourcing result by composing the existing components. Written for P1-005 on 2026-10-27.

**Status.** The orchestration infrastructure, and an offline end-to-end proof on the genuine Ettrick control set, are complete. Fully automatic live marketplace acquisition is **not** demonstrated: it still needs an authorized data source (see section 16).

## 1. Architecture

```
saved Luna fingerprint + hash-checked photo                        (understanding/saved, shortlisting/evidence)
  → candidate source: curated manifest | saved discovery run | live (blocked)   (discovery/curated, discovery/providers/apify)
  → image evidence per listing (local files only)                  (shortlisting/evidence + verification/openai/evidence)
  → SigLIP 2 shortlist: reuse if compatible, else local compute    (shortlisting/*, services/vision)
  → Sol assessments: reuse saved records; plan, never send, new ones   (verification/openai/record)
  → consolidated result.json + result.md                           (orchestration/assemble)
```

Code is in `apps/web/src/lib/sourcing/orchestration/`:

| File | Purpose |
|---|---|
| `orchestrator.ts` | `runOrchestration`: the stages, journal updates and resume |
| `stages.ts` | Typed wrappers around the existing components; no reimplementation |
| `assemble.ts` | The result and its Markdown |
| `journal.ts` | The run record and the input identity |

The CLI is `cli/source-auto.ts`. Everything is direct typed function composition. The only subprocess is the existing structured SigLIP 2 integration, used when a shortlist must be computed locally.

## 2. Service boundaries (unchanged)

- **Luna:** never called. A valid saved fingerprint is required.
- **Discovery:** operator-assisted manifests, and saved P1-004 provider runs (normalized with the same code `discover:marketplace --replay` uses).
- **SigLIP 2:** the saved shortlist, or `buildEmbedRequest` → `services/vision` → `buildVisualShortlist`.
- **Sol:** saved records from `verify:visual`. Paid requests remain exclusively in `verify:visual --live`.
- **`SourcingPipeline`:** not rewritten, and not used here. The orchestrator produces a retrieval-plus-verification result, not a `RankedSourcingResult` from the provisional ranking policy.

## 3. Candidate sources

| `--source` | Input | Notes |
|---|---|---|
| `curated` | `--manifest` (default `evals/local/candidates/<case>.json`) | Validated with the existing intake checks. The Ettrick control set. |
| `provider-run` | `--discovery-run <folder>` (a P1-004 run) | See below |
| `provider-live` | — | Always **blocked**; `--plan` shows the prerequisites |

**`provider-run` checks:**
- **Same reference:** the run must have been made from the same fingerprint and reference image.
- **Pending runs:** a run with a pending provider job is blocked. Resume it with `discover:marketplace --resume`; the orchestrator never does.
- **Failed runs:** a run with no successful snapshot fails ("a failed search, not an empty result").
- **Which manifest:** the run's recorded manifest is used when it has one. Otherwise the saved snapshots are normalized offline.
- **What is kept:** provider error rows (for example the synthetic `BLOCKED` row) and rejected-row counts are kept as diagnostics. A partly failed hybrid run is used for what succeeded, and the failed part is reported as missing.

## 4. Stages and states

The stages are `reference → candidates → image_evidence → shortlist → verification → assembly`.

| State | Meaning |
|---|---|
| `not_started` | |
| `running` | |
| `completed` | |
| `reused` | An existing compatible output was used unchanged |
| `partial` | Output, but not for every candidate |
| `blocked` | A prerequisite or authorization is missing; nothing was attempted |
| `failed` | An input is invalid |
| `skipped` | Nothing to do |

A blocked or failed stage stops the run, and earlier stages are kept. The run status is `completed`, `partial`, `blocked` or `failed`.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Completed (or a plan without blockers) |
| 4 | Partial result |
| 3 | Blocked |
| 1 | Failed or invalid |
| 2 | Usage error |

## 5. Planning and execution

- **`--plan`:** runs every check read-only and prints:
  - each stage's decision (reuse, compute or blocked);
  - the selection and any exclusions;
  - the Sol record status per listing;
  - how many paid requests would add coverage.

  It writes nothing.
- **`--run --offline`:** executes and writes `evals/local/sourcing-runs/<case>/<run id>/`, containing `run.json`, `result.json`, `result.md`, and `shortlist.json`/`shortlist.md` when computed. `--offline` is required in this version, so that no external operation can be implied.
- **`--resume <run id> --offline`:** see section 9.

## 6. Offline, external and paid operations

| Class | Operations | In `source:auto` |
|---|---|---|
| Offline | Load the fingerprint and manifests, read local images, reuse shortlists and Sol records, run SigLIP 2 with an already-cached checkpoint, write reports | Yes |
| External marketplace | Provider search, uploading the reference to a provider, downloading remote listing images | **Never.** It prints the separately authorized `discover:marketplace` command (genuine data only) |
| Paid AI | GPT-6.1 Sol and Luna requests | **Never.** It prints exact `verify:visual --listing-id … --live --max-paid-requests 1` commands |

`run.json` records the authorization explicitly as `not_authorized` for all three external classes, and counts external requests as 0. The presence of `APIFY_TOKEN` or `OPENAI_API_KEY` is never treated as permission.

## 7. Authorization

The command has no live flags. External discovery and paid verification are separate decisions, made in their own commands with their own caps:
- `discover:marketplace --live …` (blocked for this provider until access is authorized);
- `verify:visual --live --max-paid-requests n`.

A single `--live` never authorizes both.

## 8. Reuse and invalidation

**SigLIP shortlist.** These are checked in order:
1. on resume, the run folder's own `shortlist.json`;
2. an explicit `--shortlist`;
3. the default `evals/local/shortlists/<case>-<model>[-auto-<run id>].json`.

A shortlist is reused only if all of these hold (the filename alone is not enough):
- the case, reference image hash and fingerprint match;
- the checkpoint id matches;
- the revision equals the locally cached revision, when the vision environment can report it (otherwise reused with a warning);
- the image-selection policy matches;
- the synthetic/genuine flag matches;
- every current candidate with an image has a scored entry with the same image reference and SHA-256, and no extra candidates are listed.

If it isn't reusable, a new shortlist is computed locally only if the checkpoint is already cached; nothing is downloaded. Otherwise the stage is blocked. `--no-recompute` forbids computing.

**Sol records.** A record is reused only if its key matches: case, listing, reference SHA-256, candidate image SHA-256, model, instruction version, image detail and reasoning effort. Supplier changes don't affect the key.

| Classification | When |
|---|---|
| `reused` | Exactly one compatible success |
| `ambiguous` | Several compatible successes; none is chosen unless `--prefer-latest-verification` |
| `failed` | The latest compatible attempt failed; never retried automatically |
| `interrupted` | A `requested` record with no result; treated as possibly charged |
| `stale` | Records exist for other inputs (image changed, other model or instructions); listed with the reasons |
| `missing` | No record |
| `not_eligible` | No usable image |

Timestamps alone never decide compatibility.

## 9. Run journal, resume and partial failures

- **Recorded inputs:** `run.json` (atomic writes) records the source, the selection, the SigLIP and Sol settings, the authorization, and the resolved identities: reference, fingerprint, manifest SHA-256, and per-listing image SHA-256.
- **Input identity:** `inputIdentity` is a SHA-256 of all of those.
- **Repeat runs:** each run has its own id. A later run with the same identity is reported as identical, and reuses everything without any external operation.
- **Resume:** `--resume` re-runs the stages of an unfinished run in the same folder. If the inputs changed since that run (for example an image hash), it refuses, restores the recorded identities, and asks for a new run. A completed run is not resumed.
- **Partial runs:** a run can finish `partial`, for example with listings that lack images, or with no Sol record for some candidates. That is a useful result, not a failure.

## 10. Verification selection

| Policy | Behaviour |
|---|---|
| `--selection all` (default) | Every eligible candidate. For the four Ettrick candidates, all four. |
| `--selection top-k --top-k n` | The n best SigLIP ranks |

**Excluded candidates:** each one is recorded with its SigLIP rank, cosine, reason, and whether it was ever verified. Excluded candidates with a reusable assessment keep it, since reuse costs nothing.

There is no cosine threshold. On Ettrick, SigLIP ranked last the candidate Sol later rated highest. An unverified candidate is never presented as a non-match.

## 11. Ranking semantics

- **Verification ordering:** verified candidates are ordered by the Sol design similarity index, descending, with ties by listing id.
- **SigLIP:** its rank and cosine are shown alongside, as retrieval signals. There is no weighted fusion.
- **What doesn't count as a score:**
  - a missing Sol score, an API error or a missing image is not 0 and not a non-match;
  - a model abstention (`insufficient_evidence`, null index) is listed under "abstained".
- **What doesn't follow from a score:**
  - high confidence does not mean high similarity;
  - an index of 79 is not a 79% probability;
  - visual similarity says nothing about manufacturer identity.

## 12. Result schema (`result.json`, `recordType: "sourcing_result"`)

**Top level:**
- `reference`;
- `source` (with the discovery state and diagnostics);
- `stages`;
- `counts`;
- `ordering` (the stated policy);
- `models` (SigLIP id, revision, source and preprocessing; Sol settings);
- `selection` (the policy, the exclusions, and `paidRequestsNeeded`);
- `recordedUsage` (tokens from the reused Sol records);
- `externalRequestsMade: 0`;
- `verified[]`, `abstained[]` and `unverified[]`;
- `warnings` and `followUps`.

**Each entry has:**
- the listing id, product id, title and URL;
- `product`: category, price exactly as listed (no currency conversion), price tiers, MOQ, seller-reported attributes, missing fields;
- `supplier`: name, profile URL, country/location, classification, `marketplaceClaims` (badges with who reported them; not verified here), tenure, missing fields;
- `provenance`: acquisition method, provider id and access, provider run ids, capture time;
- `imageEvidence`: status, the image used (hash, size, fallback) and problems;
- `retrieval`: SigLIP rank and cosine;
- `verification`: status, selection note, rank, index, classification, confidence, summary, and the evidence lists described below, plus the record file.

**Verification evidence:** `matches`, `partialStructuralDifferences`, `structuralMismatches`, `appearanceDifferences`, `limitations` and `uncertainClaims`.
- **Partial structural differences** are partial matches on structural or proportion features, reported as differences without being turned into contradictions. Ettrick candidate 001's six arches versus the reference's seven were recorded by Sol as a defining `partial_match`. The P1-003 report's key lists left partial matches out; the consolidated report and `verify:visual --report` (`keyPartialMatches`) now show them. No saved record was changed.
- **Status values:**
  - `imageEvidence.status` is one of `available`, `remote_only`, `no_image`, `missing_file`, `corrupt`, `unsupported_format`, `too_large`, `rejected_security` or `unreadable`;
  - `verification.status` uses the values from section 8.

`result.md` has the 15 sections requested: reference, source, stages, counts and coverage, verified, unverified, explanations, differences, product and supplier details, image limitations, provenance, usage, warnings, and follow-ups. It keeps product URLs clickable, and labels marketplace facts as unverified and design judgements as AI-derived.

## 13. Product and supplier provenance

- **Listings:** the acquisition method comes from the manifest. `operator_assisted` means found by a person. `provider_api` means searched through a provider, with `providerSource {providerId, access, runIds}`; `access: "third_party_service"` marks the Apify scraper as not an official API.
- **Supplier badges:** only claims the marketplace showed are listed, with `reportedBy`. Nothing is marked verified by this application.

## 14. Tested commands

```sh
pnpm source:auto --case ettrick-bed --source curated --plan
pnpm source:auto --case ettrick-bed --source curated --run --offline
pnpm source:auto --case ettrick-bed --resume <run id> --offline
pnpm source:auto --case ettrick-bed --source provider-live --plan                     # exit 3: blocked prerequisites
pnpm source:auto --case syn-bed-001 --synthetic --predictions evals/image-understanding/synthetic/predictions \
  --source provider-run --discovery-run evals/discovery/synthetic/syn-bed-001/disc-2026-10-27T00-00-00Z-000000 --run --offline   # exit 4: partial
```

The synthetic case has only a recorded image hash and no photo file. For synthetic data only, the reference stage continues without the photo (marked `partial`), and only SigLIP recomputation is blocked. A genuine reference must resolve and match its hash.

## 15. Current limitations

- **No live acquisition:** discovery needs an authorized provider (section 16).
- **No paid steps here:** paid Sol coverage for new candidates must be run separately with `verify:visual`.
- **Revision check needs the environment:** a shortlist's checkpoint revision can only be re-checked when the `services/vision` environment is available.
- **Lighter image checks than SigLIP:** image evidence is structurally validated, and Pillow decoding happens only if SigLIP is recomputed.
- **Single-view evidence:** this is a known limitation of the underlying models.

## 16. Integrating an authorized provider

1. Obtain written access for an official Alibaba.com API or an approved partner (see `docs/automated-marketplace-discovery.md`, section 3).
2. Implement its adapter so it produces the same `provider_api` manifest and run journal.
3. Run discovery with its own explicit caps, then `source:auto --source provider-run --discovery-run <folder>`.
4. Only then consider letting `provider-live` start discovery. That would be a separate, explicitly authorized operation, with its own flag and cap.

## 17. Feeding the future web UI

`result.json` is a self-contained, versioned view model. A UI can render:
- the verified table from `verified[]`;
- per-candidate evidence panels from the evidence lists;
- the "not verified" list, with reasons, from `unverified[]`;
- the stage progress from `stages`.

Its next actions come from `followUps` and `selection.paidRequestsNeeded`, and should require explicit user approval. `run.json` provides resumable state for a background-free, request-scoped flow.
