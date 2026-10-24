export type PipelineStage =
  | "image_understanding"
  | "candidate_discovery"
  | "visual_verification"
  | "ranking";

/**
 * Raised when a pipeline stage throws or returns data that violates the
 * stage contract. The original error, if any, is kept as `cause`.
 */
export class SourcingPipelineError extends Error {
  readonly stage: PipelineStage;

  constructor(stage: PipelineStage, message: string, options?: { cause?: unknown }) {
    super(`[${stage}] ${message}`, options);
    this.name = "SourcingPipelineError";
    this.stage = stage;
  }
}
