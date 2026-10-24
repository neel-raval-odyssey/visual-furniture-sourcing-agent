import type { FurnitureFingerprint, ReferenceImage } from "../domain";

/**
 * Boundary for turning a reference photograph into a furniture fingerprint.
 * Implementations must keep the returned fingerprint associated with the
 * reference (`referenceImageIds` includes `reference.id`) and must not assume
 * a matching marketplace listing exists.
 */
export interface ImageUnderstandingService {
  analyze(reference: ReferenceImage): Promise<FurnitureFingerprint>;
}
