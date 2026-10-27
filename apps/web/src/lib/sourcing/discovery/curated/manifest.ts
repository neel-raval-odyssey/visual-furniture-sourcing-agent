import { z } from "zod";
import { dataSourceKindSchema, idSchema, isoTimestampSchema, nonEmptyStringSchema } from "../../validation/common";
import { minimumOrderSchema, priceInfoSchema } from "../../validation/listing";
import {
  supplierResponsivenessSchema,
  supplierVerificationSchema,
  tradeAssuranceSchema,
} from "../../validation/supplier";
import { canonicalUrl, checkMarketplaceUrl, productIdFromListingUrl } from "./marketplace-urls";

/**
 * Private, hand-edited record of Alibaba.com candidates that a person found
 * with Alibaba's own tools (Alibaba Lens, image search, keyword search) for one
 * evaluation case. Stored as evals/local/candidates/<case-id>.json (git-ignored).
 *
 * Optional fields may be omitted or null; both mean "not recorded". Nothing is
 * defaulted or inferred. Validation is offline: URLs are parsed, not fetched.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lower-case letters, digits and hyphens");
const maybe = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const CAPTURE_TOOLS = [
  "alibaba_lens",
  "alibaba_image_search",
  "alibaba_keyword_search",
  "other",
  /** Searches run by this application through a discovery provider (capture.method "provider_api"). */
  "provider_image_search",
  "provider_keyword_search",
] as const;
export const captureToolSchema = z.enum(CAPTURE_TOOLS);

/** Relative path to a locally saved screenshot or image, resolved against the manifest's folder. */
const localPathSchema = z
  .string()
  .refine(
    (p) =>
      !p.startsWith("/") && !/[\\:]/.test(p) && !p.split("/").includes("..") && /^[^\s].*\.(jpe?g|png|webp)$/i.test(p),
    "Expected a relative .jpg, .jpeg, .png or .webp path inside the candidates folder, without '..'",
  );

const imageExtras = {
  /** e.g. "primary", "gallery", "detail", "operator_screenshot". */
  role: maybe(nonEmptyStringSchema),
  alt: maybe(z.string()),
  mimeType: maybe(z.enum(["image/jpeg", "image/png", "image/webp"])),
};

export const manifestImageSchema = z.union([
  z.strictObject({ url: nonEmptyStringSchema, ...imageExtras }),
  z.strictObject({ localPath: localPathSchema, ...imageExtras }),
]);

/** A verification claim as displayed on Alibaba.com. `reportedBy` is required so its source is explicit. */
const manifestVerificationSchema = supplierVerificationSchema.extend({ reportedBy: nonEmptyStringSchema });

export const manifestSupplierSchema = z.strictObject({
  /** Manifest-local reference used by candidates' `supplierRef`. */
  ref: slug,
  name: nonEmptyStringSchema,
  profileUrl: maybe(nonEmptyStringSchema),
  countryCode: maybe(z.string().regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 code")),
  location: maybe(nonEmptyStringSchema),
  /** As stated on the page, e.g. "manufacturer", "trading_company". */
  classification: maybe(nonEmptyStringSchema),
  verifications: maybe(z.array(manifestVerificationSchema)),
  platformTenureYears: maybe(z.number().nonnegative()),
  tradeAssurance: maybe(tradeAssuranceSchema),
  responsiveness: maybe(supplierResponsivenessSchema),
  notes: maybe(z.string()),
});

/** One provider search that returned a candidate (provider_api manifests only). */
export const discoverySourceSchema = z.strictObject({
  mode: z.enum(["image", "keyword"]),
  providerRunId: nonEmptyStringSchema,
  /** The keyword query, or null for image search. */
  query: z.string().nullable(),
  /** 1-based position in the provider's results, when reported. */
  position: z.int().positive().nullable(),
  /** Whether the provider marked the result as a sponsored placement; null when not reported. */
  sponsored: z.boolean().nullable(),
});

/** A quantity price break as reported by the provider. */
export const priceTierSchema = z.strictObject({
  minQuantity: z.int().positive(),
  maxQuantity: z.int().positive().nullable(),
  price: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});

export const manifestCandidateSchema = z.strictObject({
  listingUrl: nonEmptyStringSchema,
  marketplaceProductId: maybe(nonEmptyStringSchema),
  title: nonEmptyStringSchema,
  category: maybe(nonEmptyStringSchema),
  images: z.array(manifestImageSchema),
  /** Seller-reported attributes copied as shown; unverified. */
  attributes: maybe(z.record(z.string(), z.string())),
  price: maybe(priceInfoSchema),
  minimumOrder: maybe(minimumOrderSchema),
  supplierRef: maybe(slug),
  /** Overrides capture.capturedAt for this candidate. */
  capturedAt: maybe(isoTimestampSchema),
  foundWith: maybe(captureToolSchema),
  /** provider_api: every provider search that returned this listing. */
  discoverySources: maybe(z.array(discoverySourceSchema).min(1)),
  /** Quantity price breaks as reported (not used for ranking). */
  priceTiers: maybe(z.array(priceTierSchema)),
  notes: maybe(z.string()),
});

/** Who ran the search, for capture.method "provider_api". */
export const captureProviderSchema = z.strictObject({
  providerId: nonEmptyStringSchema,
  /** e.g. "apify". */
  service: nonEmptyStringSchema,
  /** e.g. "scrapewise/alibaba-com-scraper". */
  source: nonEmptyStringSchema,
  /** A third-party service is not an official Alibaba.com API. */
  access: z.enum(["official_api", "third_party_service"]),
  runs: z
    .array(
      z.strictObject({
        mode: z.enum(["image", "keyword"]),
        providerRunId: nonEmptyStringSchema,
        status: nonEmptyStringSchema,
        startedAt: isoTimestampSchema.nullable(),
        finishedAt: isoTimestampSchema.nullable(),
        /** Charge reported by the provider, when available. */
        chargedUsd: z.number().nonnegative().nullable(),
      }),
    )
    .min(1),
});

export const candidateManifestSchema = z
  .strictObject({
    manifestType: z.literal("alibaba_candidate_manifest"),
    schemaVersion: z.literal(1),
    /** "live" for genuine Alibaba.com records; "mock" only for synthetic fixtures. */
    dataSource: dataSourceKindSchema,
    caseId: slug,
    referenceImageId: idSchema,
    /** Fingerprint the search handoff was prepared from. */
    fingerprintId: idSchema,
    capture: z.strictObject({
      /** "not_started": template not filled in yet. "completed": the operator finished searching. */
      status: z.enum(["not_started", "completed"]),
      /** operator_assisted: found by a person. provider_api: searched by this application through capture.provider. */
      method: z.enum(["operator_assisted", "provider_api"]),
      capturedAt: isoTimestampSchema.nullable(),
      tools: z.array(captureToolSchema),
      /** Text queries the operator typed into Alibaba.com, if any. */
      queriesTyped: z.array(nonEmptyStringSchema),
      notes: maybe(z.string()),
      provider: maybe(captureProviderSchema),
    }),
    suppliers: z.array(manifestSupplierSchema),
    candidates: z.array(manifestCandidateSchema),
  })
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const url = (value: string, purpose: Parameters<typeof checkMarketplaceUrl>[1], path: (string | number)[]) => {
      const problem = checkMarketplaceUrl(value, purpose, m.dataSource);
      if (problem) issue(path, `URL ${problem}`);
      return problem === null;
    };

    if (m.capture.status === "not_started") {
      if (m.candidates.length > 0) issue(["capture", "status"], 'Set status to "completed" once candidates are recorded');
      if (m.capture.capturedAt !== null) issue(["capture", "capturedAt"], 'Must be null while status is "not_started"');
    } else if (m.capture.capturedAt === null) {
      issue(["capture", "capturedAt"], 'Required when status is "completed"');
    }
    if (m.dataSource === "live" && m.capture.status === "completed" && m.capture.tools.length === 0) {
      issue(["capture", "tools"], "Record which Alibaba.com tool(s) were used");
    }
    const providerTools = m.capture.tools.filter((t) => t.startsWith("provider_"));
    if (m.capture.method === "provider_api") {
      if (!m.capture.provider) issue(["capture", "provider"], 'Required when method is "provider_api"');
      if (providerTools.length !== m.capture.tools.length) issue(["capture", "tools"], "provider_api manifests may only list provider_* tools");
    } else {
      if (m.capture.provider) issue(["capture", "provider"], 'Only allowed when method is "provider_api"');
      if (providerTools.length) issue(["capture", "tools"], "provider_* tools require method \"provider_api\"");
    }
    const runIds = new Set(m.capture.provider?.runs.map((r) => r.providerRunId) ?? []);

    const supplierRefs = new Set<string>();
    const profiles = new Map<string, number>();
    m.suppliers.forEach((s, i) => {
      if (supplierRefs.has(s.ref)) issue(["suppliers", i, "ref"], `Duplicate supplier ref "${s.ref}"`);
      supplierRefs.add(s.ref);
      if (s.profileUrl && url(s.profileUrl, "supplier_profile", ["suppliers", i, "profileUrl"])) {
        const key = canonicalUrl(s.profileUrl);
        const first = profiles.get(key);
        if (first !== undefined) issue(["suppliers", i, "profileUrl"], `Same profile URL as suppliers[${first}]`);
        else profiles.set(key, i);
      }
    });

    const identities = new Map<string, number>();
    m.candidates.forEach((c, i) => {
      if (!url(c.listingUrl, "listing", ["candidates", i, "listingUrl"])) return;
      const fromUrl = productIdFromListingUrl(c.listingUrl);
      if (c.marketplaceProductId && fromUrl && c.marketplaceProductId !== fromUrl) {
        issue(["candidates", i, "marketplaceProductId"], `Does not match the product id in listingUrl (${fromUrl})`);
      }
      const identity = candidateIdentity(c);
      const first = identities.get(identity);
      if (first !== undefined) issue(["candidates", i], `Duplicate listing: same product as candidates[${first}]`);
      else identities.set(identity, i);

      c.images.forEach((img, j) => {
        if ("url" in img) url(img.url, "listing_image", ["candidates", i, "images", j, "url"]);
      });
      if (c.discoverySources && m.capture.method !== "provider_api") {
        issue(["candidates", i, "discoverySources"], 'Only allowed when capture.method is "provider_api"');
      }
      c.discoverySources?.forEach((d, j) => {
        if (!runIds.has(d.providerRunId)) issue(["candidates", i, "discoverySources", j, "providerRunId"], "Not one of capture.provider.runs");
      });
      if (c.supplierRef && !supplierRefs.has(c.supplierRef)) {
        issue(["candidates", i, "supplierRef"], `No supplier with ref "${c.supplierRef}"`);
      }
    });
  });

export type CandidateManifest = z.output<typeof candidateManifestSchema>;
export type ManifestCandidate = z.output<typeof manifestCandidateSchema>;
export type ManifestSupplier = z.output<typeof manifestSupplierSchema>;

/**
 * Listing identity used for duplicate detection: the marketplace product id
 * (given, or read from a product-detail URL) when known, otherwise the
 * canonical listing URL. Titles are never used.
 */
export function candidateIdentity(c: Pick<ManifestCandidate, "listingUrl" | "marketplaceProductId">): string {
  const productId = c.marketplaceProductId ?? productIdFromListingUrl(c.listingUrl);
  return productId ? `product:${productId}` : `url:${canonicalUrl(c.listingUrl)}`;
}

/** A blank manifest for a case, written by `source:candidates --prepare`. */
export function createManifestTemplate(input: {
  caseId: string;
  referenceImageId: string;
  fingerprintId: string;
  dataSource: "live" | "mock";
}): CandidateManifest {
  return {
    manifestType: "alibaba_candidate_manifest",
    schemaVersion: 1,
    dataSource: input.dataSource,
    caseId: input.caseId,
    referenceImageId: input.referenceImageId,
    fingerprintId: input.fingerprintId,
    capture: { status: "not_started", method: "operator_assisted", capturedAt: null, tools: [], queriesTyped: [], notes: null },
    suppliers: [],
    candidates: [],
  };
}
