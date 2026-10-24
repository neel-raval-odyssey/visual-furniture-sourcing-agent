import type { FurnitureFingerprint, ReferenceImage } from "../../domain";
import type { ImageUnderstandingService } from "../types";
import { MOCK_FINGERPRINTS } from "./fixtures";

/** Thrown when the mock has no predefined fingerprint for a reference. */
export class UnsupportedReferenceError extends Error {
  constructor(readonly referenceImageId: string) {
    super(
      `No synthetic fingerprint is defined for reference "${referenceImageId}"`,
    );
    this.name = "UnsupportedReferenceError";
  }
}

export interface MockImageUnderstandingServiceOptions {
  fingerprints?: readonly FurnitureFingerprint[];
}

/**
 * Looks up a predefined fingerprint by reference id. It does not read image
 * pixels and never invents a fingerprint: unknown references throw
 * UnsupportedReferenceError.
 */
export class MockImageUnderstandingService implements ImageUnderstandingService {
  private readonly fingerprints: readonly FurnitureFingerprint[];

  constructor(options: MockImageUnderstandingServiceOptions = {}) {
    this.fingerprints = options.fingerprints ?? MOCK_FINGERPRINTS;
  }

  async analyze(reference: ReferenceImage): Promise<FurnitureFingerprint> {
    const fingerprint = this.fingerprints.find((fp) =>
      fp.referenceImageIds.includes(reference.id),
    );
    if (!fingerprint) throw new UnsupportedReferenceError(reference.id);
    return structuredClone(fingerprint);
  }
}
