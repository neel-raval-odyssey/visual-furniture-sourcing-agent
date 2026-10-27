import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { CandidateListing, ReferenceImage } from "../../domain";
import { DEFAULT_MAX_IMAGE_BYTES, ImageInputError, validateImageBytes, type ImageContent } from "../../image-input/image-content";
import { inspectImage } from "../../image-input/inspect";
import { EvidenceError, LOCAL_EVIDENCE_PREFIX, type ListingImagePlan, type ReferenceEvidence } from "../../shortlisting/evidence";
import type { RejectedImage } from "../../shortlisting/types";

/**
 * Image evidence for pairwise verification. Paths come only from the
 * shortlist evidence resolver (reference hash-checked against the saved run;
 * candidates confined to <candidates>/<case>/). Each file is read again here,
 * its hash re-checked, and its structure and dimensions validated before any
 * request. Bytes are sent unchanged; nothing is re-encoded.
 */

export interface EvidenceImage {
  /** Manifest reference (candidate localPath) or "reference". */
  ref: string;
  /** Listing image URI for candidates (local-evidence:<path>); the reference id otherwise. */
  uri: string;
  sha256: string;
  mimeType: ImageContent["mimeType"];
  width: number;
  height: number;
  content: ImageContent;
}

export interface VerificationEvidenceProvider {
  reference(reference: ReferenceImage): Promise<EvidenceImage>;
  /** The first usable image of a listing, or why none is usable. */
  candidate(listing: CandidateListing): Promise<EvidenceImage | { unusable: RejectedImage[] }>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reads a file already approved by the evidence resolver, refusing symlinks and changed content. */
export async function loadEvidenceImage(path: string, expectedSha256: string, ref: string, uri: string): Promise<EvidenceImage> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new ImageInputError("not_found", "Image file not found");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new EvidenceError(`Image "${ref}" is not a regular file`);
  if (info.size > DEFAULT_MAX_IMAGE_BYTES) {
    throw new ImageInputError("too_large", `Image "${ref}" exceeds the ${DEFAULT_MAX_IMAGE_BYTES}-byte limit`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const digest = sha256(bytes);
  if (digest !== expectedSha256) throw new EvidenceError(`Image "${ref}" changed after it was validated (SHA-256 differs)`);
  const content = validateImageBytes(bytes);
  const { width, height } = inspectImage(bytes);
  return { ref, uri, sha256: digest, mimeType: content.mimeType, width, height, content };
}

/** Evidence from a resolved reference and per-listing image plans (same selection policy as the shortlist). */
export class LocalVerificationEvidence implements VerificationEvidenceProvider {
  private readonly plans: Map<string, ListingImagePlan>;

  constructor(
    private readonly referenceEvidence: ReferenceEvidence,
    plans: readonly ListingImagePlan[],
  ) {
    this.plans = new Map(plans.map((p) => [p.listing.id, p]));
  }

  async reference(reference: ReferenceImage): Promise<EvidenceImage> {
    if (reference.id !== this.referenceEvidence.id) throw new EvidenceError(`No evidence for reference "${reference.id}"`);
    return loadEvidenceImage(this.referenceEvidence.path, this.referenceEvidence.sha256, "reference", reference.id);
  }

  async candidate(listing: CandidateListing): Promise<EvidenceImage | { unusable: RejectedImage[] }> {
    const plan = this.plans.get(listing.id);
    if (!plan) return { unusable: [] };
    const rejected = [...plan.rejected];
    for (const image of plan.images) {
      try {
        return await loadEvidenceImage(image.path, image.sha256, image.ref, `${LOCAL_EVIDENCE_PREFIX}${image.ref}`);
      } catch (error) {
        if (!(error instanceof ImageInputError)) throw error;
        rejected.push({ ref: image.ref, problem: error.message.startsWith("Corrupted image") ? "decode_failed" : error.code, message: error.message });
      }
    }
    return { unusable: rejected };
  }
}
