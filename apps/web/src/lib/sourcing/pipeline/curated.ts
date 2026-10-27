import { CuratedAlibabaDiscoveryAdapter } from "../discovery/curated/curated-alibaba-adapter";
import type { CandidateManifest } from "../discovery/curated/manifest";
import type { FurnitureFingerprint } from "../domain";
import { ProvisionalRankingService } from "../ranking/provisional-ranking";
import { SavedFingerprintImageUnderstandingService } from "../understanding/saved/saved-fingerprint";
import { UnassessedVisualVerificationService } from "../verification/unassessed-visual-verification";
import { SourcingPipeline } from "./sourcing-pipeline";

/**
 * Composition root for the operator-assisted path: a saved fingerprint (no
 * model call), operator-recorded Alibaba.com candidates, no visual
 * assessment yet, and the provisional ranking policy (which, without
 * assessments, only orders by listing id).
 */
export function createCuratedSourcingPipeline(input: {
  fingerprint: FurnitureFingerprint;
  manifests: readonly CandidateManifest[];
}): { pipeline: SourcingPipeline; discovery: CuratedAlibabaDiscoveryAdapter } {
  const discovery = new CuratedAlibabaDiscoveryAdapter({ manifests: input.manifests });
  const pipeline = new SourcingPipeline({
    imageUnderstanding: new SavedFingerprintImageUnderstandingService(input.fingerprint),
    discovery,
    visualVerification: new UnassessedVisualVerificationService(),
    ranking: new ProvisionalRankingService(),
  });
  return { pipeline, discovery };
}
