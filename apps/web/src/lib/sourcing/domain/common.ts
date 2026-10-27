/**
 * Shared primitives for sourcing domain contracts.
 *
 * Every domain contract must stay JSON-serializable: identifiers and image
 * references are strings, timestamps are ISO 8601 strings, and no runtime
 * objects (Date, File, Blob, SDK clients) appear in these types.
 */

/** ISO 8601 timestamp string, e.g. "2026-10-24T09:30:00.000Z". */
export type IsoTimestamp = string;

/**
 * A reference to an image, never the image bytes. May be an https URL, a
 * storage key, or a fixture path. Resolution is the caller's concern.
 */
export interface ImageRef {
  uri: string;
  mimeType?: string;
  widthPx?: number;
  heightPx?: number;
}

/**
 * Marketplace identifier. "alibaba" is the initial target; the open string
 * keeps the contracts usable for future providers.
 */
export type MarketplaceId = "alibaba" | (string & {});

/** Whether data came from synthetic fixtures or a real provider. */
export type DataSourceKind = "mock" | "live";

/**
 * How marketplace records were obtained:
 * - provider_api: returned by a search this application ran through a
 *   configured discovery provider. `providerSource.access` says whether that
 *   provider is an official marketplace API or a third-party service.
 * - operator_assisted: found by a person using the marketplace's own
 *   user-facing tools and recorded by hand; this application performed no
 *   search. Manual capture is not independent verification of the content.
 */
export type AcquisitionMethod = "provider_api" | "operator_assisted";

/**
 * The discovery provider behind provider_api records. A third-party service
 * (e.g. a hosted scraper) is not an official marketplace API, and its records
 * are not independently verified.
 */
export interface ProviderSource {
  /** e.g. "apify-alibaba-discovery". */
  providerId: string;
  access: "official_api" | "third_party_service";
  /** Provider run or request ids that returned the record. */
  runIds: string[];
}

/** Where a piece of marketplace data came from and when it was retrieved. */
export interface DataProvenance {
  marketplace: MarketplaceId;
  dataSource: DataSourceKind;
  /** For operator-assisted records, when the operator captured them. */
  retrievedAt: IsoTimestamp;
  /** Absent when not recorded (e.g. existing synthetic fixtures). */
  acquisitionMethod?: AcquisitionMethod;
  /** Present for provider_api records. */
  providerSource?: ProviderSource;
}
