import { MockAlibabaDiscoveryAdapter } from "../discovery/mock/mock-alibaba-adapter";
import { ProvisionalRankingService } from "../ranking/provisional-ranking";
import { MockImageUnderstandingService } from "../understanding/mock/mock-image-understanding";
import { MockVisualVerificationService } from "../verification/mock/mock-visual-verification";
import { SourcingPipeline } from "./sourcing-pipeline";

/**
 * Composition root for a fully synthetic pipeline: every stage is a mock
 * backed by fixtures, plus the provisional ranking policy. Real
 * integrations are wired the same way by passing other implementations to
 * SourcingPipeline.
 */
export function createSyntheticSourcingPipeline(
  options: { now?: () => Date } = {},
): SourcingPipeline {
  return new SourcingPipeline({
    imageUnderstanding: new MockImageUnderstandingService(),
    discovery: new MockAlibabaDiscoveryAdapter({ now: options.now }),
    visualVerification: new MockVisualVerificationService(),
    ranking: new ProvisionalRankingService(),
  });
}
