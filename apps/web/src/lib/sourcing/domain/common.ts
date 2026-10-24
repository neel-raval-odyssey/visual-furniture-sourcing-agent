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

/** Where a piece of marketplace data came from and when it was retrieved. */
export interface DataProvenance {
  marketplace: MarketplaceId;
  dataSource: DataSourceKind;
  retrievedAt: IsoTimestamp;
}
