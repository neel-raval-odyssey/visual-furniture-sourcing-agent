import type { ImageRef, IsoTimestamp } from "./common";

/**
 * Where the user's reference photograph came from. This is independent of
 * any marketplace: a reference may come from anywhere, and an exact listing
 * for it may not exist.
 */
export type ReferenceImageOriginKind =
  | "retail_website"
  | "catalogue"
  | "social_media"
  | "marketplace"
  | "personal_photo"
  | "unknown";

export interface ReferenceImageOrigin {
  kind: ReferenceImageOriginKind;
  /** Free-form platform or publisher name, e.g. "Pinterest". */
  platform?: string;
}

/** Optional details for images extracted from a printed or PDF catalogue. */
export interface CatalogueMetadata {
  title?: string;
  publisher?: string;
  pageNumber?: number;
  /** Product code printed in the catalogue, as written. */
  itemCode?: string;
}

/**
 * A single user-supplied furniture photograph. Multi-image references are
 * modelled by grouping several ReferenceImage ids (see
 * FurnitureFingerprint.referenceImageIds) rather than by changing this type.
 */
export interface ReferenceImage {
  id: string;
  image: ImageRef;
  origin: ReferenceImageOrigin;
  /** Page the image was found on, if known. */
  sourceUrl?: string;
  submittedAt: IsoTimestamp;
  catalogue?: CatalogueMetadata;
  /** Free-text context supplied by the user. */
  userNotes?: string;
}
