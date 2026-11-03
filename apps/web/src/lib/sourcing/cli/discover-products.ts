import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROVIDERS } from "../discovery/authorization";
import { buildSearchBody, EXA_LIMITS, EXA_PRICING, EXA_PROVIDER_ID, EXA_SEARCH_ENDPOINT, type FetchLike } from "../discovery/providers/exa/exa-api";
import type { FetchedImage } from "../discovery/images/safe-image-fetch";
import { CASE_ID } from "../ui/data";
import {
  automaticSearchPlan,
  fetchAutomaticSearchImages,
  listAutomaticSearches,
  resumeAutomaticSearch,
  startAutomaticSearch,
  type AutomaticSearchDeps,
  type StartOutcome,
} from "../ui/discovery/automatic-search";
import { localPaths } from "../ui/local-access";
import { loadSavedFingerprint, SavedRunError } from "../understanding/saved/saved-fingerprint";
import type { CliIO } from "./analyze-image";

/**
 * Automatic Alibaba.com product discovery from an analysed photo's saved search
 * queries, through Exa (an external web search index restricted to Alibaba.com
 * product pages; not an official Alibaba.com API). The same service the web app
 * uses. Default is a dry run: it prints the plan, the eligibility checks and
 * the exact request bodies, and sends nothing.
 */

export const PRODUCTS_EXIT_OK = 0;
export const PRODUCTS_EXIT_INVALID = 1;
export const PRODUCTS_EXIT_USAGE = 2;
/** No search request succeeded (never reported as zero results). */
export const PRODUCTS_EXIT_PROVIDER = 3;
/** The source is not eligible (policy, access record, credentials or live switch). */
export const PRODUCTS_EXIT_BLOCKED = 4;

export interface DiscoverProductsCliDeps {
  io: CliIO;
  repoRoot: string;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  convertAvif?: AutomaticSearchDeps["convertAvif"];
  /** Tests only: replaces the eligibility check over evals/local/marketplace-access.json. */
  checkAccess?: AutomaticSearchDeps["checkAccess"];
  now?: () => Date;
}

export const PRODUCTS_USAGE = `Automatic Alibaba.com product discovery from a photo's saved analysis (default: dry run, nothing sent).

Usage:
  pnpm discover:products --case <id> [--dry-run]                    Plan, eligibility checks and exact request bodies
  pnpm discover:products --case <id> --live --confirm-paid-search   Send the searches (needs an eligible source)
  pnpm discover:products --case <id> --status                       Saved automatic searches for the case
  pnpm discover:products --case <id> --resume <search id> [--live --confirm-paid-search]
                                                                    Settle an interrupted search; unsent queries are sent only with --live
  pnpm discover:products --case <id> --fetch-images <search id>     Cache the found listings' images (needs image-retrieval approval)

Source: Exa Search API (${EXA_SEARCH_ENDPOINT}), keyword search restricted to www.alibaba.com/product-detail.
Only the saved text queries are sent, never the photo. Up to ${EXA_LIMITS.maxQueries} queries, ${EXA_LIMITS.maxResultsPerQuery} results each,
${EXA_LIMITS.maxUniqueLeads} unique products kept, one request per query, no automatic retries. Credentials: EXA_API_KEY (server-side only).
Eligibility also needs project policy and a reviewed entry in evals/local/marketplace-access.json; a key alone never enables it.`;

export async function runDiscoverProductsCli(argv: string[], deps: DiscoverProductsCliDeps): Promise<number> {
  const { io } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        case: { type: "string" },
        "dry-run": { type: "boolean" },
        live: { type: "boolean" },
        "confirm-paid-search": { type: "boolean" },
        status: { type: "boolean" },
        resume: { type: "string" },
        "fetch-images": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(PRODUCTS_USAGE);
    return PRODUCTS_EXIT_USAGE;
  }
  if (values.help) {
    io.out(PRODUCTS_USAGE);
    return PRODUCTS_EXIT_OK;
  }
  const usage = (message: string) => {
    io.err(`Error: ${message}`);
    io.err(PRODUCTS_USAGE);
    return PRODUCTS_EXIT_USAGE;
  };
  const caseId = values.case as string | undefined;
  if (!caseId || !CASE_ID.test(caseId)) return usage("--case <id> is required");
  const actions = (["live", "status", "dry-run"] as string[]).filter((k) => values[k]).concat(["resume", "fetch-images"].filter((k) => values[k] !== undefined));
  const resumeLive = values.resume !== undefined && values.live;
  if (actions.length > 1 && !resumeLive) return usage("choose one of --dry-run, --live, --status, --resume or --fetch-images");
  if (values.live && !values["confirm-paid-search"]) return usage("--live needs --confirm-paid-search (Exa bills each search request)");

  const paths = localPaths(deps.repoRoot);
  const svc: AutomaticSearchDeps = { env: deps.env, fetch: deps.fetch, fetchImage: deps.fetchImage, convertAvif: deps.convertAvif, checkAccess: deps.checkAccess, now: deps.now };
  const report = (outcome: StartOutcome): number => {
    if (!outcome.ok) {
      io.err(`Not done: ${outcome.message}`);
      return outcome.code === "not_eligible" ? PRODUCTS_EXIT_BLOCKED : outcome.code === "not_found" || outcome.code === "invalid_request" ? PRODUCTS_EXIT_USAGE : PRODUCTS_EXIT_INVALID;
    }
    io.out(`Automatic search ${outcome.discoveryId}: ${outcome.status}${outcome.reused ? " (already recorded; nothing sent)" : ""}.`);
    io.out(`Saved in ${join("evals/local/discovery", caseId, outcome.discoveryId)}/`);
    return outcome.status === "failed" ? PRODUCTS_EXIT_PROVIDER : PRODUCTS_EXIT_OK;
  };

  if (values.status) {
    const searches = await listAutomaticSearches(paths, caseId);
    if (values.json) io.out(JSON.stringify(searches, null, 2));
    else if (!searches.length) io.out("No automatic searches saved for this case.");
    else
      for (const s of searches) {
        const c = s.summary?.counts;
        io.out(`${s.discoveryId}  ${s.status}${s.unfinished ? " (unfinished)" : ""}  ${s.access}`);
        io.out(c ? `  ${c.resultsReturned} returned, ${c.alibabaProductLinks} Alibaba product links, ${c.uniqueProducts} unique products, ${c.withLocalImage} with a local photo, $${s.summary!.costUsd.reported} reported` : `  ${s.meaning}`);
      }
    return PRODUCTS_EXIT_OK;
  }
  if (values["fetch-images"] !== undefined) return report(await fetchAutomaticSearchImages(paths, caseId, values["fetch-images"] as string, svc));
  if (values.resume !== undefined) return report(await resumeAutomaticSearch(paths, caseId, values.resume as string, { sendRemaining: Boolean(values.live) }, svc));

  let saved;
  try {
    saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  } catch (error) {
    io.err(`Error: ${error instanceof SavedRunError ? error.message : "the saved analysis could not be read"}`);
    return PRODUCTS_EXIT_INVALID;
  }
  const plan = await automaticSearchPlan(paths, saved, svc);
  if (values.live) {
    if (!plan.eligibility.eligible) {
      io.err(`Live search blocked: ${plan.eligibility.blocker}`);
      return PRODUCTS_EXIT_BLOCKED;
    }
    return report(await startAutomaticSearch(paths, caseId, { requestKey: randomUUID(), confirmed: true }, svc));
  }

  // Dry run: nothing is sent.
  const lines = [
    "DRY RUN — nothing is sent.",
    `Case: ${caseId}  (reference ${saved.reference.id}, fingerprint ${saved.fingerprint.id})`,
    `Provider: ${PROVIDERS[EXA_PROVIDER_ID].label}`,
    `Sends: only the saved text queries below (the photo is never sent). Endpoint: POST ${EXA_SEARCH_ENDPOINT}`,
    `Budget: ${plan.maxRequests} request(s) × ${plan.resultsPerQuery} results, at most ${plan.maxUniqueLeads} unique products kept; estimated $${plan.estimatedUsd} (Exa list prices as of ${EXA_PRICING.asOf}), cap $${plan.costCapUsd}.`,
    `Product images: ${plan.imageRetrieval.allowed ? "will be cached locally (approved)" : `not downloaded — ${plan.imageRetrieval.detail}`}`,
    `Raw responses: ${plan.rawRetention ? "kept in full (approved)" : "only the fields used are kept"}`,
    "Queries (from the saved photo analysis, unchanged):",
    ...plan.queries.map((q, i) => `  ${i + 1}. ${q}`),
    ...plan.problems.map((p) => `Plan problem: ${p}`),
    "Eligibility:",
    ...plan.eligibility.checks.map((c) => `  [${c.ok ? "ok" : "BLOCKED"}] ${c.key}: ${c.detail}`),
    `Live search: ${plan.eligibility.eligible ? "available (pnpm discover:products --case <id> --live --confirm-paid-search)" : `BLOCKED — ${plan.eligibility.blocker}`}`,
  ];
  if (values.json) {
    io.out(JSON.stringify({ dryRun: true, plan, requests: plan.queries.map((q) => ({ method: "POST", url: EXA_SEARCH_ENDPOINT, body: buildSearchBody(q, plan.resultsPerQuery) })) }, null, 2));
  } else {
    lines.forEach((l) => io.out(l));
    io.out("Request bodies (the x-api-key header is added only for a live search):");
    plan.queries.forEach((q) => io.out(`  ${JSON.stringify(buildSearchBody(q, plan.resultsPerQuery))}`));
  }
  return plan.problems.length ? PRODUCTS_EXIT_INVALID : PRODUCTS_EXIT_OK;
}
