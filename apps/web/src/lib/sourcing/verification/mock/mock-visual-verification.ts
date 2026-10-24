import type { VisualMatchAssessment } from "../../domain";
import type {
  VisualVerificationRequest,
  VisualVerificationService,
} from "../types";
import { MOCK_ASSESSMENTS } from "./fixtures";

export interface MockVisualVerificationServiceOptions {
  assessments?: readonly VisualMatchAssessment[];
}

/**
 * Returns predefined synthetic assessments for (reference, listing) pairs.
 * No images are compared and no similarity is computed. Pairs without a
 * predefined assessment are left unassessed rather than filled in.
 */
export class MockVisualVerificationService implements VisualVerificationService {
  private readonly assessments: readonly VisualMatchAssessment[];

  constructor(options: MockVisualVerificationServiceOptions = {}) {
    this.assessments = options.assessments ?? MOCK_ASSESSMENTS;
  }

  async verify(
    request: VisualVerificationRequest,
  ): Promise<VisualMatchAssessment[]> {
    return request.listings.flatMap((listing) => {
      const assessment = this.assessments.find(
        (a) =>
          a.referenceImageId === request.reference.id &&
          a.listingId === listing.id,
      );
      return assessment ? [structuredClone(assessment)] : [];
    });
  }
}
