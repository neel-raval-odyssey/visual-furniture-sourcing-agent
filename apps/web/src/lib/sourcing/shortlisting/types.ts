import type { IsoTimestamp } from "../domain";

/**
 * Retrieval-stage visual shortlist: candidates ordered by the cosine
 * similarity of image embeddings to the reference photograph.
 *
 * `embeddingCosineSimilarity` is a ranking signal only. It is not a design
 * match percentage, a calibrated confidence, an exact-design verification or
 * evidence of the same product or manufacturer. It is deliberately kept apart
 * from VisualMatchAssessment (designSimilarityIndex, confidence,
 * classification), which only a detailed visual verifier may fill in.
 */

export const SHORTLIST_METHOD = "image_embedding_cosine";

/** Image-selection policy applied to every listing, recorded in each shortlist. */
export const IMAGE_SELECTION_POLICY =
  "One image per listing: the first usable local image, trying images with role \"primary\" first and then the " +
  "rest in manifest order. Later images are used only when earlier ones are missing or cannot be decoded; " +
  "scores are never maximised over several images. Remote image URLs are not fetched.";

export type ImageRejectionReason =
  | "remote_url_not_fetched"
  | "missing_file"
  | "empty_file"
  | "unreadable_file"
  | "too_large"
  | "too_many_pixels"
  | "unsupported_format"
  | "decode_failed";

export interface RejectedImage {
  /** Manifest image reference: the localPath, or the remote URL. */
  ref: string;
  problem: ImageRejectionReason | (string & {});
  message: string;
}

export interface ShortlistModelInfo {
  id: string;
  /** Resolved Hugging Face commit hash of the checkpoint snapshot used. */
  revision: string;
  architecture: string;
  modelType: string;
  embeddingDim: number;
  featureSource: string;
  dtype: string;
}

export interface ShortlistImage {
  /** Manifest localPath, relative to the candidates folder. */
  ref: string;
  role: string | null;
  sha256: string;
  format: string;
  width: number;
  height: number;
  /** True when this is not the listing's first-choice image. */
  fallback: boolean;
}

export interface ShortlistEntry {
  rank: number;
  listingId: string;
  marketplaceProductId: string | null;
  title: string;
  listingUrl: string;
  supplier: { id: string; name: string } | null;
  image: ShortlistImage;
  rejectedImages: RejectedImage[];
  embeddingCosineSimilarity: number;
  visualVerificationStatus: "not_assessed";
}

export interface ExcludedListing {
  listingId: string;
  title: string;
  listingUrl: string;
  supplier: { id: string; name: string } | null;
  reason: "no_image" | "no_usable_image";
  rejectedImages: RejectedImage[];
}

export interface VisualShortlist {
  recordType: "visual_shortlist";
  schemaVersion: 1;
  caseId: string;
  createdAt: IsoTimestamp;
  /** True when the reference fingerprint or the candidates are synthetic. */
  synthetic: boolean;
  method: {
    kind: typeof SHORTLIST_METHOD;
    score: "embeddingCosineSimilarity";
    ordering: "descending cosine similarity; ties by ascending listing id";
    interpretation: string;
  };
  /** Null only when no candidate image could be embedded, so no model ran. */
  model: ShortlistModelInfo | null;
  device: { type: string; requested: string; reason: string } | null;
  preprocessing: Record<string, unknown> | null;
  runtime: Record<string, string> | null;
  reference: {
    referenceImageId: string;
    fingerprintId: string;
    sha256: string;
    /** Decoded image details; null when no model ran. */
    image: { format: string; width: number; height: number } | null;
  };
  candidates: { manifestCapturedAt: IsoTimestamp; acquisitionMethod: "operator_assisted"; providerId: string };
  imageSelectionPolicy: string;
  topK: number;
  counts: { listings: number; embedded: number; shortlisted: number; belowTopK: number; excluded: number };
  /** Top-K embedded listings, best first. */
  shortlist: ShortlistEntry[];
  /** Embedded listings ranked below top-K (ids only, in rank order). */
  belowTopK: string[];
  excluded: ExcludedListing[];
  visualVerification: { status: "not_assessed"; note: string };
}

export const SCORE_INTERPRETATION =
  "Raw cosine similarity between L2-normalized SigLIP 2 image embeddings of the whole reference photograph and " +
  "the whole candidate image. Higher means more similar to this model, relative to the other candidates scored " +
  "with the same checkpoint and preprocessing. It is a retrieval ranking signal, not a probability, confidence, " +
  "design-match percentage or verification, and room backgrounds and styling can influence it.";
