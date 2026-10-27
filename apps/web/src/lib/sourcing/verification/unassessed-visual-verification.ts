import type { VisualMatchAssessment } from "../domain";
import type { VisualVerificationRequest, VisualVerificationService } from "./types";

/**
 * Stand-in for real candidates while visual matching (SigLIP 2 shortlisting,
 * GPT-6.1 Sol verification) is not implemented. It returns no assessments, so
 * every candidate stays "not assessed": no similarity, confidence or
 * classification is produced.
 */
export class UnassessedVisualVerificationService implements VisualVerificationService {
  async verify(request: VisualVerificationRequest): Promise<VisualMatchAssessment[]> {
    void request;
    return [];
  }
}
