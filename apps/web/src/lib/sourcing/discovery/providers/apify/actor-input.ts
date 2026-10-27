/**
 * Input construction and budgeting for the Scrapewise "Alibaba Image Search &
 * Product Scraper" Actor, per its published input schema (build 0.1.6,
 * checked 2026-10-27): keywords, imageUrls, imageFile, maxItems,
 * maxItemsPerKeyword, maxResultsPerImage, searchType, includeDetails.
 *
 * It is a third-party scraper run on Apify, not an official Alibaba.com API.
 */

export const APIFY_PROVIDER_ID = "apify-alibaba-discovery";
export const SCRAPEWISE_ACTOR = "scrapewise/alibaba-com-scraper";
export const PROVIDER_SOURCE_LABEL = `apify:${SCRAPEWISE_ACTOR}`;

/** Published pay-per-event prices (Free tier, the highest), checked 2026-10-27. */
export const PRICING = {
  checkedAt: "2026-10-27",
  imageSearchUsd: 0.004,
  /** Image search covers this many products; each further one is a "result". */
  imageSearchIncludedResults: 60,
  resultUsd: 0.001,
} as const;

export const LIMITS = {
  maxResults: 50,
  maxQueries: 4,
  maxCostUsd: 10,
  runTimeoutSecs: 300,
} as const;

export type SearchMode = "image" | "keyword";
export type DiscoveryModeOption = SearchMode | "hybrid";

/** How the reference photo reaches the provider. */
export type ImageTransport =
  /** A user-approved HTTPS URL the user already controls; sent as `imageUrls`. */
  | { kind: "url"; url: string }
  /** A temporary record in the user's own Apify storage; its URL is sent as `imageFile`. */
  | { kind: "apify_storage"; url: string };

export interface ActorInput {
  searchType: "products";
  includeDetails: false;
  maxItems: number;
  imageUrls?: string[];
  imageFile?: string;
  maxResultsPerImage?: number;
  keywords?: string[];
  maxItemsPerKeyword?: number;
}

export function buildImageSearchInput(transport: ImageTransport, maxResults: number): ActorInput {
  const base: ActorInput = { searchType: "products", includeDetails: false, maxItems: maxResults, maxResultsPerImage: maxResults };
  return transport.kind === "url" ? { ...base, imageUrls: [transport.url] } : { ...base, imageFile: transport.url };
}

export function buildKeywordInput(queries: readonly string[], maxResults: number): ActorInput {
  if (queries.length === 0) throw new Error("Keyword search needs at least one query");
  return {
    searchType: "products",
    includeDetails: false,
    keywords: [...queries],
    maxItems: maxResults,
    // Keeps one broad query from using the whole budget.
    maxItemsPerKeyword: Math.max(1, Math.ceil(maxResults / queries.length)),
  };
}

/** Worst-case event charge for one run at published prices (no platform-usage component assumed). */
export function estimateRunCostUsd(mode: SearchMode, maxResults: number): number {
  const results = mode === "image" ? Math.max(0, maxResults - PRICING.imageSearchIncludedResults) : maxResults;
  const cost = (mode === "image" ? PRICING.imageSearchUsd : 0) + results * PRICING.resultUsd;
  return Math.round(cost * 10_000) / 10_000;
}

export interface PlannedRun {
  mode: SearchMode;
  maxResults: number;
  queries: string[];
  estimatedUsd: number;
  /** Passed to Apify as maxTotalChargeUsd. */
  costCapUsd: number;
}

export interface DiscoveryPlan {
  runs: PlannedRun[];
  estimatedUsd: number;
  costCapUsd: number;
  problems: string[];
}

/**
 * One provider run per search mode (hybrid = an image run and a keyword run,
 * budgeted separately). The total cap is split evenly between runs and each
 * share must cover that run's worst-case estimate.
 */
export function planDiscovery(input: {
  mode: DiscoveryModeOption;
  maxResults: number;
  fingerprintQueries: readonly string[];
  maxQueries: number;
  costCapUsd: number;
}): DiscoveryPlan {
  const problems: string[] = [];
  const modes: SearchMode[] = input.mode === "hybrid" ? ["image", "keyword"] : [input.mode];
  const queries = input.fingerprintQueries.slice(0, input.maxQueries);
  if (modes.includes("keyword") && queries.length === 0) problems.push("The saved fingerprint has no search queries for keyword mode");
  const share = Math.floor((input.costCapUsd / modes.length) * 10_000) / 10_000;
  const runs = modes.map((mode) => {
    const estimatedUsd = estimateRunCostUsd(mode, input.maxResults);
    if (share < estimatedUsd) {
      problems.push(`The ${mode} run may cost up to $${estimatedUsd} but its share of the cap is $${share}; raise --max-provider-cost-usd`);
    }
    return { mode, maxResults: input.maxResults, queries: mode === "keyword" ? queries : [], estimatedUsd, costCapUsd: share };
  });
  const estimatedUsd = Math.round(runs.reduce((a, r) => a + r.estimatedUsd, 0) * 10_000) / 10_000;
  return { runs, estimatedUsd, costCapUsd: input.costCapUsd, problems };
}
