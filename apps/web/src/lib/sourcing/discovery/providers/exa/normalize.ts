import type { DataSourceKind } from "../../../domain";
import { summarizeIssues } from "../../../validation/issues";
import { candidateIdentity, candidateManifestSchema, type CandidateManifest, type ManifestCandidate } from "../../curated/manifest";
import { checkMarketplaceUrl, productIdFromListingUrl } from "../../curated/marketplace-urls";
import { EXA_LIMITS, EXA_PROVIDER_ID, EXA_SOURCE_LABEL, exaResultSchema } from "./exa-api";

/**
 * Exa search results → provider_api candidate-manifest entries. Each result is
 * checked on its own: only an https Alibaba.com product-detail page with a
 * numeric product id and a furniture title becomes a candidate. Nothing is
 * fetched, inferred or invented: supplier data is never derived from a title
 * or URL, and price / minimum order are kept only when the page excerpt states
 * them explicitly (and are labelled possibly stale).
 */

export type ExaRejectionReason =
  | "not_an_object"
  | "invalid_url"
  /** Another site, a lookalike domain, or another Alibaba Group marketplace. */
  | "not_alibaba"
  /** An Alibaba.com page that is not a product-detail page (search, category, showroom, supplier page). */
  | "not_product_page"
  | "missing_title"
  | "not_furniture"
  | "duplicate"
  | "over_limit";

export interface ExaRejection {
  mode: "keyword";
  providerRunId: string;
  query: string;
  index: number;
  url: string | null;
  reason: ExaRejectionReason;
  detail: string;
}

export interface ExaNormalizedCandidate {
  identity: string;
  candidate: ManifestCandidate;
  warnings: string[];
}

export interface ExaQueryRows {
  providerRunId: string;
  query: string;
  capturedAt: string;
  items: unknown[];
}

/** Words that make a title plausibly a piece of furniture. A title without any is rejected, not guessed. */
const FURNITURE_TERMS =
  /\b(furniture|tables?|desks?|chairs?|armchairs?|sofas?|couch(es)?|loveseats?|beds?|bedframes?|headboards?|cabinets?|cupboards?|sideboards?|buffets?|consoles?|dressers?|wardrobes?|nightstands?|bedside|shel(f|ves)|bookcases?|bookshelf|stools?|benches|bench|ottomans?|poufs?|drawers?|credenzas?|vanity|tv stand|coffee|nesting)\b/i;

export function looksLikeFurniture(title: string): boolean {
  return FURNITURE_TERMS.test(title);
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");

/** https://www.alibaba.com/product-detail/x_123.html?spm=… → without query or fragment. */
function cleanUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Price and minimum order as written in a page excerpt. Currency is set only
 * when written unambiguously ("US$", "USD"); a bare "$" leaves it unknown.
 * Returns null fields when nothing explicit is found.
 */
export function readPriceAndMoq(excerpts: readonly string[]): { price: ManifestCandidate["price"]; minimumOrder: ManifestCandidate["minimumOrder"]; quoted: string | null } {
  const text = excerpts.join(" \n ");
  let price: ManifestCandidate["price"] = null;
  let quoted: string | null = null;
  const m = /(US\s?\$|USD\s?|\$)\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?:\s?[-–~]\s?(?:US\s?\$|USD\s?|\$)?\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?))?/.exec(text);
  if (m) {
    const min = Number(m[2].replace(/,/g, ""));
    const max = m[3] ? Number(m[3].replace(/,/g, "")) : undefined;
    if (Number.isFinite(min) && (max === undefined || (Number.isFinite(max) && max >= min))) {
      const explicitUsd = /^(US\s?\$|USD)/.test(m[1]);
      price = { min, ...(max !== undefined && max !== min ? { max } : {}), ...(explicitUsd ? { currency: "USD" } : {}) };
      quoted = collapse(m[0]);
    }
  }
  let minimumOrder: ManifestCandidate["minimumOrder"] = null;
  const o = /(?:Min\.?\s*order|Minimum\s+order(?:\s+quantity)?|MOQ)\s*[:：]?\s*(\d{1,3}(?:,\d{3})*|\d+)\s*([A-Za-z]+(?:\/[A-Za-z]+)?)?/i.exec(text);
  if (o) {
    const quantity = Number(o[1].replace(/,/g, ""));
    if (Number.isInteger(quantity) && quantity > 0) minimumOrder = { quantity, ...(o[2] ? { unit: o[2].toLowerCase() } : {}) };
  }
  return { price, minimumOrder, quoted };
}

/** Normalizes the saved results of one query. Positions are 1-based within that query. */
export function normalizeExaRows(rows: ExaQueryRows, dataSource: DataSourceKind): { candidates: ExaNormalizedCandidate[]; rejections: ExaRejection[] } {
  const candidates: ExaNormalizedCandidate[] = [];
  const rejections: ExaRejection[] = [];
  const seen = new Set<string>();
  rows.items.forEach((item, index) => {
    const reject = (reason: ExaRejectionReason, detail: string, url: string | null = null) =>
      rejections.push({ mode: "keyword", providerRunId: rows.providerRunId, query: rows.query, index, url, reason, detail });
    const parsed = exaResultSchema.safeParse(item);
    if (!parsed.success) return reject("not_an_object", "Result does not have a url");
    const r = parsed.data;
    let listingUrl: string;
    try {
      listingUrl = cleanUrl(r.url);
    } catch {
      return reject("invalid_url", "Not a valid URL", r.url.slice(0, 300));
    }
    const hostProblem = checkMarketplaceUrl(listingUrl, "listing", dataSource);
    if (hostProblem) return reject(/https|credentials|port|valid URL/.test(hostProblem) ? "invalid_url" : "not_alibaba", `URL ${hostProblem}`, listingUrl);
    const productId = productIdFromListingUrl(listingUrl);
    if (!productId) return reject("not_product_page", "Not an Alibaba.com product-detail page with a numeric product id", listingUrl);
    const title = r.title ? collapse(r.title) : "";
    if (!title) return reject("missing_title", "No title reported", listingUrl);
    if (!looksLikeFurniture(title)) return reject("not_furniture", `Title does not describe furniture: "${title.slice(0, 120)}"`, listingUrl);
    const identity = candidateIdentity({ listingUrl, marketplaceProductId: productId });
    if (seen.has(identity)) return reject("duplicate", `Product ${productId} already returned by this query`, listingUrl);
    seen.add(identity);

    const warnings: string[] = [];
    const images: ManifestCandidate["images"] = [];
    if (r.image) {
      const imageProblem = checkMarketplaceUrl(r.image, "listing_image", dataSource);
      if (imageProblem) warnings.push(`preview image ignored (URL ${imageProblem})`);
      else images.push({ url: r.image, role: "primary", alt: null, mimeType: null });
    }
    const { price, minimumOrder, quoted } = readPriceAndMoq(r.highlights ?? []);
    const notes = [
      "Found by an external search index (Exa), not by Alibaba.com; not a verification of the listing, its supplier or its availability.",
      images.length
        ? "Image: the page's preview image as reported by the search index (one image; gallery images were not requested)."
        : "No product image was reported for this page.",
      price || minimumOrder
        ? `Price/minimum order as written in the indexed page excerpt${quoted ? ` ("${quoted}")` : ""}; may be stale, confirm on the listing.`
        : "Price and minimum order not reported.",
      "Supplier not reported by the search index.",
    ];
    candidates.push({
      identity,
      warnings,
      candidate: {
        listingUrl,
        marketplaceProductId: productId,
        title,
        images,
        ...(price ? { price } : {}),
        ...(minimumOrder ? { minimumOrder } : {}),
        capturedAt: rows.capturedAt,
        foundWith: "provider_keyword_search",
        discoverySources: [{ mode: "keyword", providerRunId: rows.providerRunId, query: rows.query, position: index + 1, sponsored: null }],
        notes: notes.join(" "),
      },
    });
  });
  return { candidates, rejections };
}

export interface ExaManifestBuild {
  manifest: CandidateManifest;
  rawCount: number;
  duplicatesMerged: number;
  rejections: ExaRejection[];
  warnings: { listingUrl: string; warning: string }[];
}

/**
 * Merges the queries' candidates in query order: a product returned by several
 * queries is kept once with every discovery source; at most `maxUniqueLeads`
 * products are kept, the rest are recorded as over_limit.
 */
export function buildExaManifest(input: {
  caseId: string;
  referenceImageId: string;
  fingerprintId: string;
  dataSource: DataSourceKind;
  capturedAt: string;
  runs: { providerRunId: string; status: string; startedAt: string | null; finishedAt: string | null; chargedUsd: number | null }[];
  rows: ExaQueryRows[];
  queries: string[];
  maxUniqueLeads?: number;
  notes: string;
}): ExaManifestBuild {
  const max = input.maxUniqueLeads ?? EXA_LIMITS.maxUniqueLeads;
  const byIdentity = new Map<string, ManifestCandidate>();
  const rejections: ExaRejection[] = [];
  const warnings: ExaManifestBuild["warnings"] = [];
  let duplicatesMerged = 0;
  let rawCount = 0;
  for (const rows of input.rows) {
    rawCount += rows.items.length;
    const n = normalizeExaRows(rows, input.dataSource);
    rejections.push(...n.rejections);
    for (const c of n.candidates) {
      const existing = byIdentity.get(c.identity);
      if (existing) {
        duplicatesMerged++;
        existing.discoverySources = [...(existing.discoverySources ?? []), ...(c.candidate.discoverySources ?? [])];
        continue;
      }
      if (byIdentity.size >= max) {
        const src = c.candidate.discoverySources![0];
        rejections.push({ mode: "keyword", providerRunId: src.providerRunId, query: src.query ?? "", index: (src.position ?? 1) - 1, url: c.candidate.listingUrl, reason: "over_limit", detail: `More than ${max} unique products in this run` });
        continue;
      }
      c.warnings.forEach((w) => warnings.push({ listingUrl: c.candidate.listingUrl, warning: w }));
      byIdentity.set(c.identity, { ...c.candidate });
    }
  }
  const manifest = {
    manifestType: "alibaba_candidate_manifest" as const,
    schemaVersion: 1 as const,
    dataSource: input.dataSource,
    caseId: input.caseId,
    referenceImageId: input.referenceImageId,
    fingerprintId: input.fingerprintId,
    capture: {
      status: "completed" as const,
      method: "provider_api" as const,
      capturedAt: input.capturedAt,
      tools: ["provider_keyword_search" as const],
      queriesTyped: input.queries,
      notes: input.notes,
      provider: {
        providerId: EXA_PROVIDER_ID,
        service: "exa",
        source: EXA_SOURCE_LABEL,
        access: "external_search_index" as const,
        runs: input.runs.map((r) => ({ mode: "keyword" as const, ...r })),
      },
    },
    suppliers: [],
    candidates: [...byIdentity.values()],
  };
  const checked = candidateManifestSchema.safeParse(manifest);
  if (!checked.success) throw new Error(`Generated manifest failed validation: ${summarizeIssues(checked.error)}`);
  return { manifest: checked.data, rawCount, duplicatesMerged, rejections, warnings };
}
