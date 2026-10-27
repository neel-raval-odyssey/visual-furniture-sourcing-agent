import { createHash } from "node:crypto";
import type { CandidateListing, DataProvenance, DataSourceKind, ListingImage, SupplierProfile } from "../../domain";
import type {
  AlibabaDiscoveryAdapter,
  DiscoveryProviderInfo,
  DiscoverySearchRequest,
  DiscoverySearchResult,
} from "../types";
import {
  candidateIdentity,
  type CandidateManifest,
  type ManifestCandidate,
  type ManifestSupplier,
} from "./manifest";
import { canonicalUrl } from "./marketplace-urls";

/**
 * Discovery adapter for Alibaba.com candidates that a person found with
 * Alibaba's own tools and recorded in a candidate manifest. It performs no
 * search and makes no network request: it only normalizes already-validated
 * manifests into CandidateListing / SupplierProfile records.
 *
 * It does not judge visual similarity. Listings come back in manifest order,
 * and that order means nothing beyond the operator's recording order.
 */

export const CURATED_PROVIDER_ID = "curated-alibaba";

/** No usable operator input exists for the request: not evidence that Alibaba has no matches. */
export class MissingCandidateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCandidateInputError";
  }
}

/** The manifests do not belong to the requested reference or fingerprint. */
export class CandidateAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateAssociationError";
  }
}

export type ListingField =
  | "marketplaceProductId"
  | "category"
  | "attributes"
  | "price"
  | "minimumOrder"
  | "supplier"
  | "images";

export type SupplierField =
  | "profileUrl"
  | "countryCode"
  | "location"
  | "classification"
  | "verifications"
  | "platformTenureYears"
  | "tradeAssurance"
  | "responsiveness";

export interface ImportedListingInfo {
  listingId: string;
  identity: string;
  foundWith: string | null;
  imageEvidence: {
    remote: number;
    local: number;
    /** False when there is no image at all: the listing cannot be compared visually. */
    suitableForVisualComparison: boolean;
  };
  missingFields: ListingField[];
}

export interface CuratedImport {
  dataSource: DataSourceKind;
  listings: CandidateListing[];
  suppliers: SupplierProfile[];
  info: ImportedListingInfo[];
  missingSupplierFields: Record<string, SupplierField[]>;
  /** Later copies of a listing already imported from an earlier manifest. */
  skippedDuplicates: { identity: string; keptListingId: string; manifestIndex: number; candidateIndex: number }[];
  /** Latest capture time across the manifests. */
  /** Listings imported but not returned because of the request limit. */
  excludedByLimit: number;
  capturedAt: string;
  tools: string[];
  queriesTyped: string[];
}

const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);
const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function prefix(dataSource: DataSourceKind) {
  return dataSource === "mock" ? "synthetic-" : "";
}

function listingIdFor(identity: string, dataSource: DataSourceKind): string {
  return identity.startsWith("product:")
    ? `${prefix(dataSource)}alibaba-product-${identity.slice("product:".length)}`
    : `${prefix(dataSource)}alibaba-url-${hash(identity, 16)}`;
}

/** Suppliers are only merged across manifests when they share a profile URL, never by name. */
function supplierIdFor(s: ManifestSupplier, m: CandidateManifest): string {
  if (s.profileUrl) return `${prefix(m.dataSource)}alibaba-supplier-${hash(canonicalUrl(s.profileUrl), 16)}`;
  const manifestKey = hash(JSON.stringify([m.caseId, m.capture.capturedAt, m.suppliers.map((x) => x.ref)]), 8);
  return `${prefix(m.dataSource)}curated-supplier-${m.caseId}-${manifestKey}-${s.ref}`;
}

function toImage(img: CandidateManifest["candidates"][number]["images"][number]): ListingImage {
  const out: ListingImage = { uri: "url" in img ? img.url : `local-evidence:${img.localPath}` };
  if (present(img.mimeType)) out.mimeType = img.mimeType;
  if (present(img.role)) out.role = img.role;
  if (present(img.alt)) out.alt = img.alt;
  return out;
}

function toSupplier(s: ManifestSupplier, id: string, provenance: DataProvenance): SupplierProfile {
  const out: SupplierProfile = { id, name: s.name, provenance };
  if (present(s.profileUrl)) out.profileUrl = s.profileUrl;
  if (present(s.countryCode)) out.countryCode = s.countryCode;
  if (present(s.location)) out.location = s.location;
  if (present(s.classification)) out.classification = s.classification;
  if (present(s.verifications)) out.verifications = s.verifications.map((v) => ({ ...v }));
  if (present(s.platformTenureYears)) out.platformTenureYears = s.platformTenureYears;
  if (present(s.tradeAssurance)) out.tradeAssurance = structuredClone(s.tradeAssurance);
  if (present(s.responsiveness)) out.responsiveness = { ...s.responsiveness };
  return out;
}

function missingSupplierFields(s: SupplierProfile): SupplierField[] {
  const fields: SupplierField[] = [
    "profileUrl",
    "countryCode",
    "location",
    "classification",
    "verifications",
    "platformTenureYears",
    "tradeAssurance",
    "responsiveness",
  ];
  return fields.filter((f) => s[f] === undefined);
}

function toListing(
  c: ManifestCandidate,
  id: string,
  supplierId: string | undefined,
  provenance: DataProvenance,
): CandidateListing {
  const productId = c.marketplaceProductId ?? undefined;
  const fromIdentity = candidateIdentity(c);
  const out: CandidateListing = {
    id,
    title: c.title,
    listingUrl: c.listingUrl,
    images: c.images.map(toImage),
    provenance,
  };
  if (productId) out.marketplaceProductId = productId;
  else if (fromIdentity.startsWith("product:")) out.marketplaceProductId = fromIdentity.slice("product:".length);
  if (present(c.category)) out.category = c.category;
  if (present(c.attributes) && Object.keys(c.attributes).length > 0) out.attributes = { ...c.attributes };
  if (present(c.price)) out.price = { ...c.price };
  if (present(c.minimumOrder)) out.minimumOrder = { ...c.minimumOrder };
  if (supplierId) out.supplierId = supplierId;
  return out;
}

/**
 * Normalizes validated manifests (all for the same reference) into domain
 * records. Deterministic: identical input gives identical output. Within a
 * manifest duplicates are already rejected by validation; across manifests
 * the first occurrence of a listing identity is kept and later ones reported.
 */
export function importCuratedCandidates(manifests: readonly CandidateManifest[]): CuratedImport {
  if (manifests.length === 0) throw new MissingCandidateInputError("No candidate manifest was supplied");
  const sources = new Set(manifests.map((m) => m.dataSource));
  if (sources.size > 1) throw new CandidateAssociationError("Cannot combine synthetic and genuine manifests");
  const dataSource = manifests[0].dataSource;
  const references = new Set(manifests.map((m) => `${m.caseId}|${m.referenceImageId}|${m.fingerprintId}`));
  if (references.size > 1) throw new CandidateAssociationError("Manifests belong to different cases, references or fingerprints");
  const unfinished = manifests.findIndex((m) => m.capture.status !== "completed");
  if (unfinished !== -1) {
    throw new MissingCandidateInputError(
      `Candidate manifest ${unfinished + 1} has capture.status "not_started": candidates have not been recorded yet`,
    );
  }

  const listings: CandidateListing[] = [];
  const info: ImportedListingInfo[] = [];
  const suppliers = new Map<string, SupplierProfile>();
  const seen = new Map<string, string>();
  const skippedDuplicates: CuratedImport["skippedDuplicates"] = [];

  manifests.forEach((m, manifestIndex) => {
    const base = { marketplace: "alibaba", dataSource, acquisitionMethod: "operator_assisted" } as const;
    const supplierIds = new Map<string, string>();
    for (const s of m.suppliers) {
      const id = supplierIdFor(s, m);
      supplierIds.set(s.ref, id);
    }

    m.candidates.forEach((c, candidateIndex) => {
      const identity = candidateIdentity(c);
      const kept = seen.get(identity);
      if (kept) {
        skippedDuplicates.push({ identity, keptListingId: kept, manifestIndex, candidateIndex });
        return;
      }
      const id = listingIdFor(identity, dataSource);
      seen.set(identity, id);
      const provenance: DataProvenance = { ...base, retrievedAt: c.capturedAt ?? (m.capture.capturedAt as string) };

      const supplierId = c.supplierRef ? supplierIds.get(c.supplierRef) : undefined;
      if (c.supplierRef && supplierId && !suppliers.has(supplierId)) {
        const s = m.suppliers.find((x) => x.ref === c.supplierRef) as ManifestSupplier;
        suppliers.set(supplierId, toSupplier(s, supplierId, { ...base, retrievedAt: m.capture.capturedAt as string }));
      }
      const listing = toListing(c, id, supplierId, provenance);
      listings.push(listing);

      const remote = c.images.filter((img) => "url" in img).length;
      const local = c.images.length - remote;
      const missing: ListingField[] = [];
      if (!listing.marketplaceProductId) missing.push("marketplaceProductId");
      if (!listing.category) missing.push("category");
      if (!listing.attributes) missing.push("attributes");
      if (!listing.price) missing.push("price");
      if (!listing.minimumOrder) missing.push("minimumOrder");
      if (!listing.supplierId) missing.push("supplier");
      if (listing.images.length === 0) missing.push("images");
      info.push({
        listingId: id,
        identity,
        foundWith: c.foundWith ?? null,
        imageEvidence: { remote, local, suitableForVisualComparison: c.images.length > 0 },
        missingFields: missing,
      });
    });
  });

  const supplierList = [...suppliers.values()];
  const capturedAt = manifests
    .map((m) => m.capture.capturedAt as string)
    .reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return {
    dataSource,
    listings,
    suppliers: supplierList,
    info,
    missingSupplierFields: Object.fromEntries(supplierList.map((s) => [s.id, missingSupplierFields(s)])),
    skippedDuplicates,
    excludedByLimit: 0,
    capturedAt,
    tools: [...new Set(manifests.flatMap((m) => m.capture.tools))],
    queriesTyped: [...new Set(manifests.flatMap((m) => m.capture.queriesTyped))],
  };
}

export interface CuratedAlibabaDiscoveryAdapterOptions {
  /** Validated manifests for one reference. */
  manifests: readonly CandidateManifest[];
}

export class CuratedAlibabaDiscoveryAdapter implements AlibabaDiscoveryAdapter {
  private readonly manifests: readonly CandidateManifest[];
  /** Details of the most recent import (missing fields, duplicates, image evidence). */
  lastImport: CuratedImport | undefined;

  constructor(options: CuratedAlibabaDiscoveryAdapterOptions) {
    this.manifests = structuredClone(options.manifests);
  }

  async discoverCandidates(input: DiscoverySearchRequest): Promise<DiscoverySearchResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new RangeError(`limit must be a positive integer, received ${input.limit}`);
    }
    for (const m of this.manifests) {
      if (m.referenceImageId !== input.reference.id) {
        throw new CandidateAssociationError(
          `Manifest for case "${m.caseId}" belongs to reference "${m.referenceImageId}", not "${input.reference.id}"`,
        );
      }
      if (input.fingerprint && m.fingerprintId !== input.fingerprint.id) {
        throw new CandidateAssociationError(
          `Manifest for case "${m.caseId}" was prepared from fingerprint "${m.fingerprintId}", not "${input.fingerprint.id}"`,
        );
      }
    }

    const imported = importCuratedCandidates(this.manifests);
    const listings = imported.listings.slice(0, input.limit);
    const kept = new Set(listings.map((l) => l.id));
    const supplierIds = new Set(listings.flatMap((l) => l.supplierId ?? []));
    const suppliers = imported.suppliers.filter((s) => supplierIds.has(s.id));
    this.lastImport = {
      ...imported,
      listings,
      suppliers,
      info: imported.info.filter((i) => kept.has(i.listingId)),
      missingSupplierFields: Object.fromEntries(suppliers.map((s) => [s.id, imported.missingSupplierFields[s.id]])),
      excludedByLimit: imported.listings.length - listings.length,
    };

    const provider: DiscoveryProviderInfo = {
      providerId: CURATED_PROVIDER_ID,
      marketplace: "alibaba",
      dataSource: imported.dataSource,
      acquisitionMethod: "operator_assisted",
    };
    return {
      listings: structuredClone(listings),
      suppliers: structuredClone(suppliers),
      provider,
      retrievedAt: imported.capturedAt,
      // This application applied no query or category filter: the operator searched on Alibaba.com.
      queriesUsed: [],
    };
  }
}
