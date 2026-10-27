import { createHash } from "node:crypto";
import { z } from "zod";
import type { DataSourceKind } from "../../../domain";
import {
  candidateIdentity,
  candidateManifestSchema,
  type CandidateManifest,
  type ManifestCandidate,
  type ManifestSupplier,
} from "../../curated/manifest";
import { canonicalUrl, checkMarketplaceUrl, productIdFromListingUrl } from "../../curated/marketplace-urls";
import { summarizeIssues } from "../../../validation/issues";
import { APIFY_PROVIDER_ID, PROVIDER_SOURCE_LABEL, type SearchMode } from "./actor-input";

/**
 * Untrusted provider rows → candidate-manifest entries. Rows are validated one
 * by one: a malformed or error row is rejected with a reason, never turned into
 * a product, and never fills a gap with a guessed value. A response whose shape
 * no longer matches the documented fields fails as a whole.
 */

const text = z.string().nullable().optional();
const num = z.number().nullable().optional();

const supplierSchema = z.looseObject({
  companyName: text,
  name: text,
  country: text,
  goldSupplierYears: num,
  verified: z.boolean().nullable().optional(),
  verifiedPro: z.boolean().nullable().optional(),
  tradeAssurance: z.boolean().nullable().optional(),
  responseRate: z.union([z.number(), z.string()]).nullable().optional(),
  businessType: text,
  url: text,
  companyUrl: text,
  storeUrl: text,
  profileUrl: text,
});

export const productRowSchema = z.looseObject({
  type: z.literal("product"),
  productId: z.union([z.string(), z.number()]).nullable().optional(),
  title: text,
  url: text,
  category: text,
  priceMin: num,
  priceMax: num,
  currency: text,
  priceTiers: z.array(z.unknown()).nullable().optional(),
  minOrderQuantity: num,
  unit: text,
  imageUrl: text,
  images: z.array(z.unknown()).nullable().optional(),
  isAd: z.boolean().nullable().optional(),
  position: num,
  searchInput: text,
  searchedAs: text,
  scrapedAt: text,
  supplier: supplierSchema.nullable().optional(),
});

const errorRowSchema = z.looseObject({ type: z.literal("error"), errorCode: text, error: text });

export type RejectionReason =
  | "not_an_object"
  | "unexpected_row_type"
  | "invalid_row"
  | "missing_title"
  | "invalid_listing_url"
  | "product_id_mismatch"
  | "duplicate";

export interface RowRejection {
  mode: SearchMode;
  providerRunId: string;
  index: number;
  reason: RejectionReason;
  detail: string;
}

export interface ProviderErrorRow {
  mode: SearchMode;
  providerRunId: string;
  index: number;
  code: string;
  message: string;
}

/** The response as a whole does not match the documented output: never treated as "no results". */
export class ProviderSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSchemaError";
  }
}

export interface NormalizedCandidate {
  identity: string;
  candidate: Omit<ManifestCandidate, "supplierRef">;
  supplier: Omit<ManifestSupplier, "ref"> | null;
  warnings: string[];
}

export interface RunRows {
  mode: SearchMode;
  providerRunId: string;
  /** Run finish time; used when a row has no valid scrapedAt. */
  capturedAt: string;
  items: unknown[];
}

export interface NormalizedRun {
  mode: SearchMode;
  providerRunId: string;
  rawCount: number;
  candidates: NormalizedCandidate[];
  rejections: RowRejection[];
  providerErrors: ProviderErrorRow[];
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
const isoOrNull = (v: string | null | undefined) => (v && !Number.isNaN(Date.parse(v)) && /T/.test(v) ? new Date(v).toISOString() : null);

/** "//host/x.jpg" → "https://host/x.jpg"; query and fragment removed from listing URLs. */
function absolutize(value: string): string {
  const v = value.trim();
  return v.startsWith("//") ? `https:${v}` : v;
}

function cleanListingUrl(value: string): string {
  const url = new URL(absolutize(value));
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parsePriceTiers(raw: unknown[] | null | undefined, warnings: string[]): ManifestCandidate["priceTiers"] {
  if (!raw || raw.length === 0) return undefined;
  const tiers: NonNullable<ManifestCandidate["priceTiers"]> = [];
  for (const t of raw) {
    const o = (t ?? {}) as Record<string, unknown>;
    const min = o.minQuantity ?? o.min ?? o.quantityMin ?? o.from;
    const max = o.maxQuantity ?? o.max ?? o.quantityMax ?? o.to;
    const price = o.price;
    const currency = typeof o.currency === "string" ? o.currency.toUpperCase() : null;
    if (Number.isInteger(min) && (min as number) > 0 && typeof price === "number" && price >= 0) {
      tiers.push({
        minQuantity: min as number,
        maxQuantity: Number.isInteger(max) && (max as number) >= (min as number) ? (max as number) : null,
        price,
        currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      });
    } else {
      warnings.push("price tier in an unrecognised format was not recorded");
      return tiers.length ? tiers : undefined;
    }
  }
  return tiers;
}

function parseResponseRate(v: number | string | null | undefined): number | undefined {
  const n = typeof v === "string" ? Number(v.trim().replace(/%$/, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100 && (typeof v === "string" ? /%$/.test(v.trim()) : n > 1) ? n : undefined;
}

function normalizeSupplier(raw: z.output<typeof supplierSchema> | null | undefined, dataSource: DataSourceKind): Omit<ManifestSupplier, "ref"> | null {
  const name = raw?.companyName ?? raw?.name;
  if (!raw || !name || !collapse(name)) return null;
  const out: Omit<ManifestSupplier, "ref"> = { name: collapse(name) };
  for (const candidate of [raw.url, raw.companyUrl, raw.storeUrl, raw.profileUrl]) {
    if (!candidate) continue;
    const url = absolutize(candidate);
    if (checkMarketplaceUrl(url, "supplier_profile", dataSource) === null) {
      out.profileUrl = url;
      break;
    }
  }
  const country = raw.country?.trim();
  if (country) {
    if (/^[A-Za-z]{2}$/.test(country)) out.countryCode = country.toUpperCase();
    else out.location = country;
  }
  if (raw.businessType && collapse(raw.businessType)) out.classification = collapse(raw.businessType);
  if (typeof raw.goldSupplierYears === "number" && raw.goldSupplierYears >= 0) out.platformTenureYears = raw.goldSupplierYears;
  // Only positive badges are recorded. A false or missing badge means "not shown", never "not verified".
  const reportedBy = `alibaba.com (as reported by ${PROVIDER_SOURCE_LABEL})`;
  const verifications = [
    ...(raw.verified === true ? [{ type: "verified_supplier_badge", status: "verified" as const, reportedBy }] : []),
    ...(raw.verifiedPro === true ? [{ type: "verified_pro_supplier_badge", status: "verified" as const, reportedBy }] : []),
  ];
  if (verifications.length) out.verifications = verifications;
  if (raw.tradeAssurance === true) out.tradeAssurance = { available: true };
  const rate = parseResponseRate(raw.responseRate);
  if (rate !== undefined) out.responsiveness = { responseRatePercent: rate };
  return out;
}

/** Validates and normalizes the rows of one provider run. */
export function normalizeRunRows(run: RunRows, dataSource: DataSourceKind): NormalizedRun {
  const out: NormalizedRun = { mode: run.mode, providerRunId: run.providerRunId, rawCount: run.items.length, candidates: [], rejections: [], providerErrors: [] };
  const reject = (index: number, reason: RejectionReason, detail: string) =>
    out.rejections.push({ mode: run.mode, providerRunId: run.providerRunId, index, reason, detail });

  const typed = run.items.filter((r) => r && typeof r === "object" && typeof (r as { type?: unknown }).type === "string").length;
  if (run.items.length > 0 && typed === 0) {
    throw new ProviderSchemaError(`None of the ${run.items.length} ${run.mode} rows has a "type" field: the provider output format has changed`);
  }

  const seen = new Set<string>();
  run.items.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return reject(index, "not_an_object", "row is not a JSON object");
    const type = (row as { type?: unknown }).type;
    if (type === "error") {
      const e = errorRowSchema.safeParse(row);
      out.providerErrors.push({
        mode: run.mode,
        providerRunId: run.providerRunId,
        index,
        code: (e.success && e.data.errorCode) || "unknown",
        message: ((e.success && e.data.error) || "error row without a message").slice(0, 300),
      });
      return;
    }
    if (type !== "product") return reject(index, "unexpected_row_type", `type "${String(type).slice(0, 40)}"`);
    const parsed = productRowSchema.safeParse(row);
    if (!parsed.success) return reject(index, "invalid_row", summarizeIssues(parsed.error));
    const r = parsed.data;
    const warnings: string[] = [];

    const title = r.title ? collapse(r.title).slice(0, 500) : "";
    if (!title) return reject(index, "missing_title", "no title");
    if (!r.url) return reject(index, "invalid_listing_url", "no listing URL");
    let listingUrl: string;
    try {
      listingUrl = cleanListingUrl(r.url);
    } catch {
      return reject(index, "invalid_listing_url", "not a valid URL");
    }
    const urlProblem = checkMarketplaceUrl(listingUrl, "listing", dataSource);
    if (urlProblem) return reject(index, "invalid_listing_url", urlProblem);
    const fromUrl = productIdFromListingUrl(listingUrl);
    const given = r.productId === null || r.productId === undefined ? undefined : String(r.productId).trim();
    const productId = given && /^\d{6,}$/.test(given) ? given : undefined;
    if (given && !productId) warnings.push("provider product id was not numeric and was not used");
    if (productId && fromUrl && productId !== fromUrl) return reject(index, "product_id_mismatch", `id ${productId} vs URL ${fromUrl}`);

    const candidate: Omit<ManifestCandidate, "supplierRef"> = { listingUrl, title, images: [] };
    if (productId ?? fromUrl) candidate.marketplaceProductId = productId ?? fromUrl;
    const identity = candidateIdentity(candidate);
    if (seen.has(identity)) return reject(index, "duplicate", `same product as an earlier row (${identity})`);
    seen.add(identity);

    if (r.category && collapse(r.category)) candidate.category = collapse(r.category);
    const imageUrls = [r.imageUrl, ...(r.images ?? [])].filter((u): u is string => typeof u === "string" && u.trim() !== "");
    const images = new Set<string>();
    for (const u of imageUrls) {
      const url = absolutize(u);
      if (checkMarketplaceUrl(url, "listing_image", dataSource) === null) images.add(url);
      else warnings.push("an image URL outside alibaba.com/alicdn.com was ignored");
    }
    candidate.images = [...images].slice(0, 10).map((url, i) => ({ url, ...(i === 0 ? { role: "primary" } : { role: "gallery" }) }));
    if (candidate.images.length === 0) warnings.push("no usable image URL");

    if (typeof r.priceMin === "number" && r.priceMin >= 0) {
      const currency = r.currency?.trim().toUpperCase();
      candidate.price = {
        min: r.priceMin,
        ...(typeof r.priceMax === "number" && r.priceMax >= r.priceMin ? { max: r.priceMax } : {}),
        ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
        ...(r.unit && collapse(r.unit) ? { unit: collapse(r.unit) } : {}),
      };
      if (!candidate.price.currency) warnings.push("price has no recognised currency");
    }
    const tiers = parsePriceTiers(r.priceTiers, warnings);
    if (tiers?.length) candidate.priceTiers = tiers;
    if (typeof r.minOrderQuantity === "number" && Number.isInteger(r.minOrderQuantity) && r.minOrderQuantity > 0) {
      candidate.minimumOrder = { quantity: r.minOrderQuantity, ...(r.unit && collapse(r.unit) ? { unit: collapse(r.unit) } : {}) };
    }
    candidate.capturedAt = isoOrNull(r.scrapedAt) ?? run.capturedAt;
    candidate.foundWith = run.mode === "image" ? "provider_image_search" : "provider_keyword_search";
    candidate.discoverySources = [
      {
        mode: run.mode,
        providerRunId: run.providerRunId,
        query: run.mode === "keyword" ? (r.searchInput ? collapse(r.searchInput) : null) : null,
        position: typeof r.position === "number" && Number.isInteger(r.position) && r.position > 0 ? r.position : null,
        sponsored: typeof r.isAd === "boolean" ? r.isAd : null,
      },
    ];
    out.candidates.push({ identity, candidate, supplier: normalizeSupplier(r.supplier, dataSource), warnings });
  });

  if (run.items.length >= 4 && out.rejections.filter((x) => x.reason === "invalid_row").length > run.items.length / 2) {
    throw new ProviderSchemaError(`Most ${run.mode} rows failed validation: the provider output format may have changed`);
  }
  return out;
}

export interface ProviderRunSummary {
  mode: SearchMode;
  providerRunId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  chargedUsd: number | null;
}

export interface BuildManifestInput {
  caseId: string;
  referenceImageId: string;
  fingerprintId: string;
  dataSource: DataSourceKind;
  capturedAt: string;
  runs: ProviderRunSummary[];
  normalized: NormalizedRun[];
  queries: string[];
  notes: string;
}

export interface ManifestBuild {
  manifest: CandidateManifest;
  duplicatesMerged: number;
  rejections: RowRejection[];
  warnings: { listingUrl: string; warning: string }[];
}

const slugHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/**
 * Merges the runs into one provider_api manifest. A product returned by both
 * image and keyword search is kept once, with both discovery sources.
 * Suppliers are merged only when they share a profile URL, never by name.
 */
export function buildProviderManifest(input: BuildManifestInput): ManifestBuild {
  const byIdentity = new Map<string, { candidate: ManifestCandidate; supplier: Omit<ManifestSupplier, "ref"> | null }>();
  const order: string[] = [];
  let duplicatesMerged = 0;
  const warnings: ManifestBuild["warnings"] = [];
  for (const run of input.normalized) {
    for (const n of run.candidates) {
      n.warnings.forEach((w) => warnings.push({ listingUrl: n.candidate.listingUrl, warning: w }));
      const existing = byIdentity.get(n.identity);
      if (existing) {
        duplicatesMerged++;
        existing.candidate.discoverySources = [...(existing.candidate.discoverySources ?? []), ...(n.candidate.discoverySources ?? [])];
        continue;
      }
      byIdentity.set(n.identity, { candidate: { ...n.candidate }, supplier: n.supplier });
      order.push(n.identity);
    }
  }

  const suppliers: ManifestSupplier[] = [];
  const refByProfile = new Map<string, string>();
  const candidates: ManifestCandidate[] = order.map((identity) => {
    const { candidate, supplier } = byIdentity.get(identity)!;
    if (!supplier) return candidate;
    const key = supplier.profileUrl ? canonicalUrl(supplier.profileUrl) : null;
    let ref = key ? refByProfile.get(key) : undefined;
    if (!ref) {
      ref = `s-${slugHash(key ?? `listing:${identity}`)}`;
      suppliers.push({ ref, ...supplier });
      if (key) refByProfile.set(key, ref);
    }
    return { ...candidate, supplierRef: ref };
  });

  const modes = new Set(input.runs.map((r) => r.mode));
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
      tools: [...(modes.has("image") ? ["provider_image_search" as const] : []), ...(modes.has("keyword") ? ["provider_keyword_search" as const] : [])],
      queriesTyped: input.queries,
      notes: input.notes,
      provider: {
        providerId: APIFY_PROVIDER_ID,
        service: "apify",
        source: PROVIDER_SOURCE_LABEL.slice("apify:".length),
        access: "third_party_service" as const,
        runs: input.runs.map((r) => ({
          mode: r.mode,
          providerRunId: r.providerRunId,
          status: r.status,
          startedAt: isoOrNull(r.startedAt),
          finishedAt: isoOrNull(r.finishedAt),
          chargedUsd: r.chargedUsd,
        })),
      },
    },
    suppliers,
    candidates,
  };
  const checked = candidateManifestSchema.safeParse(manifest);
  if (!checked.success) throw new Error(`Generated manifest failed validation: ${summarizeIssues(checked.error)}`);
  return { manifest: checked.data, duplicatesMerged, rejections: input.normalized.flatMap((n) => n.rejections), warnings };
}
