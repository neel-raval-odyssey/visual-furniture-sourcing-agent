import type { DataProvenance, ImageRef } from "./common";

export interface ListingImage extends ImageRef {
  /** e.g. "primary", "gallery", "detail". Open string. */
  role?: string;
  alt?: string;
}

export interface PriceInfo {
  min: number;
  /** Present when the listing shows a price range. */
  max?: number;
  /** ISO 4217 code when known, e.g. "USD". */
  currency?: string;
  /** Pricing unit as reported, e.g. "piece", "set". */
  unit?: string;
}

export interface MinimumOrder {
  quantity: number;
  unit?: string;
}

/**
 * A product discovered on a marketplace. Only identity, title, URL, images and
 * provenance are required; real listings are often incomplete.
 */
export interface CandidateListing {
  /** Internal id, unique across providers. */
  id: string;
  /** The marketplace's own product id, when available. */
  marketplaceProductId?: string;
  title: string;
  listingUrl: string;
  /** Multiple views where available. May be empty. */
  images: ListingImage[];
  /** Product category as reported or mapped, e.g. "chair". */
  category?: string;
  /** Seller-reported attributes (unverified), e.g. { material: "steel" }. */
  attributes?: Record<string, string>;
  price?: PriceInfo;
  minimumOrder?: MinimumOrder;
  /** References SupplierProfile.id. */
  supplierId?: string;
  provenance: DataProvenance;
}
