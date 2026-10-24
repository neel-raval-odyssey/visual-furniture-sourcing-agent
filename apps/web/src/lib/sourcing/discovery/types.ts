import type {
  CandidateListing,
  DataSourceKind,
  FurnitureFingerprint,
  IsoTimestamp,
  MarketplaceId,
  ReferenceImage,
  SupplierProfile,
} from "../domain";

/** How the provider should search: by image, by text, or both. */
export type DiscoveryMode = "image" | "text" | "image_and_text";

export interface DiscoverySearchRequest {
  reference: ReferenceImage;
  /** Present once image understanding has run. */
  fingerprint?: FurnitureFingerprint;
  mode: DiscoveryMode;
  /** Text queries. Defaults to fingerprint.searchQueries when omitted. */
  queries?: string[];
  /** Category filter. Defaults to fingerprint.category when omitted. */
  category?: string;
  /** Maximum number of listings to return. Positive integer. */
  limit: number;
}

export interface DiscoveryProviderInfo {
  /** Adapter identifier, e.g. "mock-alibaba". */
  providerId: string;
  marketplace: MarketplaceId;
  /** "mock" for synthetic fixtures, "live" for a real provider. */
  dataSource: DataSourceKind;
}

/**
 * Candidates only. Discovery never scores visual similarity or ranks results;
 * listing order carries no meaning beyond what the provider returned.
 */
export interface DiscoverySearchResult {
  listings: CandidateListing[];
  /** Suppliers referenced by the returned listings, deduplicated by id. */
  suppliers: SupplierProfile[];
  provider: DiscoveryProviderInfo;
  retrievedAt: IsoTimestamp;
  /** The text queries actually applied, after defaults. */
  queriesUsed: string[];
  /** The category filter actually applied, after defaults. */
  categoryUsed?: string;
}

/**
 * Boundary for Alibaba candidate discovery. A live implementation requires a
 * confirmed, authorized integration; none exists yet.
 */
export interface AlibabaDiscoveryAdapter {
  discoverCandidates(
    input: DiscoverySearchRequest,
  ): Promise<DiscoverySearchResult>;
}
