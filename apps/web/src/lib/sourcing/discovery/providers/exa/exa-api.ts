import { z } from "zod";

/**
 * Exa Search API (https://exa.ai/docs/reference/search), used as an external
 * web search index restricted to Alibaba.com product pages. It is NOT an
 * official Alibaba.com API and not an Alibaba.com partner: it reports pages
 * its index has seen. A result does not verify a listing, its supplier, its
 * price or that it is still available.
 *
 * Only documented request fields are sent: query, type, numResults,
 * includeDomains, contents.highlights {query, maxCharacters}. The reference
 * photo is never sent; only the saved text queries from the photo analysis.
 * One HTTP request per query, never retried automatically.
 */

export const EXA_PROVIDER_ID = "exa-alibaba-index";
export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
export const EXA_CREDENTIAL_ENV = "EXA_API_KEY";
/** "host plus path prefix" form of includeDomains: only Alibaba.com product-detail pages. */
export const EXA_INCLUDE_DOMAINS = ["www.alibaba.com/product-detail"] as const;
export const EXA_SOURCE_LABEL = `exa:/search includeDomains=${EXA_INCLUDE_DOMAINS.join(",")}`;
/** Asks for the page excerpt that mentions price and minimum order, so they can be read without fetching the page. */
export const EXA_HIGHLIGHTS_QUERY = "price per piece and minimum order quantity";

export const EXA_LIMITS = {
  maxQueries: 4,
  maxResultsPerQuery: 10,
  /** Unique product leads kept per discovery run. */
  maxUniqueLeads: 20,
  /** Hard ceiling for a per-run cost cap. */
  maxCostUsd: 1,
  requestTimeoutMs: 30_000,
} as const;

/**
 * Published prices (https://exa.ai/pricing, read 2026-11-03), used only for a
 * pre-flight estimate; the charge Exa reports in costDollars is what is
 * recorded. Search "auto": $7 per 1k requests up to 10 results, $1 per 1k
 * extra results; highlights: $1 per 1k pages.
 */
export const EXA_PRICING = { searchPerRequestUsd: 0.007, extraResultUsd: 0.001, highlightsPerPageUsd: 0.001, asOf: "2026-11-03" } as const;

export function estimateSearchCostUsd(numResults: number): number {
  const usd = EXA_PRICING.searchPerRequestUsd + Math.max(0, numResults - 10) * EXA_PRICING.extraResultUsd + numResults * EXA_PRICING.highlightsPerPageUsd;
  return Math.round(usd * 10_000) / 10_000;
}

export interface ExaSearchBody {
  query: string;
  type: "auto";
  numResults: number;
  includeDomains: string[];
  contents: { highlights: { query: string; maxCharacters: number } };
}

export function buildSearchBody(query: string, numResults: number): ExaSearchBody {
  const q = query.trim();
  if (!q) throw new RangeError("query must not be empty");
  if (!Number.isInteger(numResults) || numResults < 1 || numResults > EXA_LIMITS.maxResultsPerQuery) {
    throw new RangeError(`numResults must be 1-${EXA_LIMITS.maxResultsPerQuery}`);
  }
  return {
    query: q,
    type: "auto",
    numResults,
    includeDomains: [...EXA_INCLUDE_DOMAINS],
    contents: { highlights: { query: EXA_HIGHLIGHTS_QUERY, maxCharacters: 600 } },
  };
}

const nstr = z.string().nullable().optional();
/** One result, documented fields only; unknown fields are tolerated and ignored. */
export const exaResultSchema = z.looseObject({
  url: z.string(),
  title: nstr,
  id: nstr,
  publishedDate: nstr,
  author: nstr,
  image: nstr,
  highlights: z.array(z.string()).nullable().optional(),
});
export const exaSearchResponseSchema = z.looseObject({
  requestId: nstr,
  results: z.array(z.unknown()),
  costDollars: z.looseObject({ total: z.number().nonnegative().optional() }).nullable().optional(),
  searchTime: z.number().nullable().optional(),
});
export type ExaSearchResponse = z.output<typeof exaSearchResponseSchema>;
export type ExaResult = z.output<typeof exaResultSchema>;

export type ExaErrorCategory =
  | "authentication"
  | "payment_required"
  | "permission"
  | "rate_limit"
  | "bad_request"
  | "server_error"
  | "invalid_response"
  /** No answer: the request may have been processed and billed. Never re-sent automatically. */
  | "timeout"
  | "network";

export class ExaError extends Error {
  constructor(
    readonly category: ExaErrorCategory,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ExaError";
  }
}

/** True when Exa may have received and billed the request even though no answer arrived. */
export const isUncertainOutcome = (e: ExaError) => e.category === "timeout" || e.category === "network";

export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

const CATEGORY_BY_STATUS: Record<number, ExaErrorCategory> = { 400: "bad_request", 401: "authentication", 402: "payment_required", 403: "permission", 422: "bad_request", 429: "rate_limit" };

/** One POST /search. The API key is sent only in the x-api-key header and never appears in errors. */
export async function exaSearch(body: ExaSearchBody, options: { apiKey: string; fetch: FetchLike; timeoutMs?: number }): Promise<ExaSearchResponse> {
  if (!options.apiKey.trim()) throw new ExaError("authentication", `${EXA_CREDENTIAL_ENV} is not set`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? EXA_LIMITS.requestTimeoutMs);
  let status: number;
  let text: string;
  try {
    const response = await options.fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": options.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new ExaError("timeout", "Exa did not answer in time; the request may still have been processed and billed");
    throw new ExaError("network", `Network error talking to Exa (${(error as Error).name}); the request may have been processed`);
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status >= 300) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const m = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
      detail = m ? `: ${m.replace(options.apiKey, "[redacted]").slice(0, 200)}` : "";
    } catch {
      // not JSON; keep the status only
    }
    throw new ExaError(CATEGORY_BY_STATUS[status] ?? (status >= 500 ? "server_error" : "bad_request"), `Exa answered HTTP ${status}${detail}`, status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExaError("invalid_response", "Exa's answer is not JSON");
  }
  const parsed = exaSearchResponseSchema.safeParse(json);
  if (!parsed.success) throw new ExaError("invalid_response", "Exa's answer does not match the documented search response (no results array)");
  return parsed.data;
}
