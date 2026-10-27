import { CuratedAlibabaDiscoveryAdapter } from "../discovery/curated/curated-alibaba-adapter";
import type { CandidateManifest } from "../discovery/curated/manifest";
import type { FurnitureFingerprint } from "../domain";
import { ProvisionalRankingService } from "../ranking/provisional-ranking";
import { SavedFingerprintImageUnderstandingService } from "../understanding/saved/saved-fingerprint";
import type { VisualVerificationService } from "../verification/types";
import { SourcingPipeline } from "./sourcing-pipeline";

/**
 * Composition root for the operator-assisted path with a real visual
 * verifier: like createCuratedSourcingPipeline, but the caller supplies the
 * VisualVerificationService (e.g. OpenAIVisualVerificationService with an
 * explicit request budget). Nothing here creates a paid client: a pipeline
 * only verifies with paid requests when the caller deliberately passes such a
 * service. Listings the verifier does not assess stay unassessed.
 */
export function createVerifiedCuratedSourcingPipeline(input: {
  fingerprint: FurnitureFingerprint;
  manifests: readonly CandidateManifest[];
  visualVerification: VisualVerificationService;
}): { pipeline: SourcingPipeline; discovery: CuratedAlibabaDiscoveryAdapter } {
  const discovery = new CuratedAlibabaDiscoveryAdapter({ manifests: input.manifests });
  const pipeline = new SourcingPipeline({
    imageUnderstanding: new SavedFingerprintImageUnderstandingService(input.fingerprint),
    discovery,
    visualVerification: input.visualVerification,
    ranking: new ProvisionalRankingService(),
  });
  return { pipeline, discovery };
}
