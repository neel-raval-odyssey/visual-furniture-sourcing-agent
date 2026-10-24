import { z } from "zod";
import type {
  CandidateListing,
  FurnitureFingerprint,
  RankedSourcingResult,
  ReferenceImage,
  VisualMatchAssessment,
} from "../domain";
import type {
  AlibabaDiscoveryAdapter,
  DiscoveryMode,
  DiscoverySearchResult,
} from "../discovery/types";
import type { SourcingRankingService } from "../ranking/types";
import type { ImageUnderstandingService } from "../understanding/types";
import type { VisualVerificationService } from "../verification/types";
import { visualMatchAssessmentSchema } from "../validation/assessment";
import { discoverySearchResultSchema } from "../validation/discovery";
import { furnitureFingerprintSchema } from "../validation/fingerprint";
import { summarizeIssues } from "../validation/issues";
import { rankedSourcingResultSchema } from "../validation/result";
import { SourcingPipelineError, type PipelineStage } from "./errors";

export const DEFAULT_CANDIDATE_LIMIT = 20;

const assessmentsSchema = z.array(visualMatchAssessmentSchema);
const rankedResultsSchema = z.array(rankedSourcingResultSchema);

export interface SourcingPipelineDependencies {
  imageUnderstanding: ImageUnderstandingService;
  discovery: AlibabaDiscoveryAdapter;
  visualVerification: VisualVerificationService;
  ranking: SourcingRankingService;
}

export interface SourcingPipelineInput {
  /** A single reference photograph. Multi-reference runs are not supported yet. */
  reference: ReferenceImage;
  discovery?: {
    /** Defaults to DEFAULT_CANDIDATE_LIMIT. */
    limit?: number;
    /** Defaults to "image_and_text". */
    mode?: DiscoveryMode;
  };
}

/**
 * Output of one run. Provenance stays on the stage outputs:
 * `fingerprint.source`, `discovery.provider.dataSource`, listing and supplier
 * `provenance`, and assessment `metadata`.
 */
export interface SourcingPipelineResult {
  reference: ReferenceImage;
  fingerprint: FurnitureFingerprint;
  discovery: DiscoverySearchResult;
  assessments: VisualMatchAssessment[];
  results: RankedSourcingResult[];
}

/**
 * Runs image understanding → discovery → visual verification → ranking with
 * injected services. Each stage's output passes two checks before the next
 * stage runs:
 *   1. structural validation against its runtime schema (is the data
 *      well-formed?), then
 *   2. integrity checks (does it belong to this run: ids, associations,
 *      coverage?).
 * Any failure is raised as a SourcingPipelineError naming the stage. No stage
 * output is ever repaired or replaced with fabricated data.
 *
 * An empty discovery result is not an error: verification is skipped (there
 * is nothing to assess) and the run returns empty assessments and results.
 */
export class SourcingPipeline {
  constructor(private readonly deps: SourcingPipelineDependencies) {}

  async run(input: SourcingPipelineInput): Promise<SourcingPipelineResult> {
    const reference = structuredClone(input.reference);

    const fingerprint = parseStageOutput(
      "image_understanding",
      furnitureFingerprintSchema,
      await runStage("image_understanding", () =>
        this.deps.imageUnderstanding.analyze(structuredClone(reference)),
      ),
    );
    if (!fingerprint.referenceImageIds.includes(reference.id)) {
      throw new SourcingPipelineError(
        "image_understanding",
        `Fingerprint "${fingerprint.id}" is not associated with reference "${reference.id}"`,
      );
    }

    const discovery = parseStageOutput(
      "candidate_discovery",
      discoverySearchResultSchema,
      await runStage("candidate_discovery", () =>
        this.deps.discovery.discoverCandidates({
          reference: structuredClone(reference),
          fingerprint: structuredClone(fingerprint),
          mode: input.discovery?.mode ?? "image_and_text",
          limit: input.discovery?.limit ?? DEFAULT_CANDIDATE_LIMIT,
        }),
      ),
    );
    checkDiscoveryIntegrity(discovery);

    const assessments =
      discovery.listings.length === 0
        ? []
        : parseStageOutput(
            "visual_verification",
            assessmentsSchema,
            await runStage("visual_verification", () =>
              this.deps.visualVerification.verify({
                reference: structuredClone(reference),
                fingerprint: structuredClone(fingerprint),
                listings: structuredClone(discovery.listings),
              }),
            ),
          );
    checkAssessmentIntegrity(assessments, discovery.listings, reference, fingerprint);

    const results = parseStageOutput(
      "ranking",
      rankedResultsSchema,
      await runStage("ranking", () =>
        this.deps.ranking.rank({
          listings: structuredClone(discovery.listings),
          suppliers: structuredClone(discovery.suppliers),
          assessments: structuredClone(assessments),
        }),
      ),
    );
    checkResultIntegrity(results, discovery.listings);

    return { reference, fingerprint, discovery, assessments, results };
  }
}

async function runStage<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourcingPipelineError(stage, `Stage failed: ${message}`, { cause: error });
  }
}

/**
 * Structural validation of a stage's runtime output. Returns the parsed copy;
 * nothing is coerced or defaulted. The ZodError is kept as `cause`, and the
 * message lists field paths and issue codes only, never the payload.
 */
function parseStageOutput<S extends z.ZodType>(
  stage: PipelineStage,
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SourcingPipelineError(
      stage,
      `Output failed validation: ${summarizeIssues(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function findDuplicate(ids: string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function checkDiscoveryIntegrity(discovery: DiscoverySearchResult): void {
  const fail = (message: string) => {
    throw new SourcingPipelineError("candidate_discovery", message);
  };
  const duplicateListing = findDuplicate(discovery.listings.map((l) => l.id));
  if (duplicateListing) fail(`Duplicate listing id "${duplicateListing}"`);

  const duplicateSupplier = findDuplicate(discovery.suppliers.map((s) => s.id));
  if (duplicateSupplier) fail(`Duplicate supplier id "${duplicateSupplier}"`);
}

function checkAssessmentIntegrity(
  assessments: VisualMatchAssessment[],
  listings: CandidateListing[],
  reference: ReferenceImage,
  fingerprint: FurnitureFingerprint,
): void {
  const fail = (message: string) => {
    throw new SourcingPipelineError("visual_verification", message);
  };
  const listingIds = new Set(listings.map((l) => l.id));
  const assessedListings = new Set<string>();

  for (const a of assessments) {
    if (!listingIds.has(a.listingId)) {
      fail(`Assessment "${a.id}" refers to unknown listing "${a.listingId}"`);
    }
    if (assessedListings.has(a.listingId)) {
      fail(`Multiple assessments for listing "${a.listingId}"`);
    }
    assessedListings.add(a.listingId);

    if (a.referenceImageId !== reference.id) {
      fail(`Assessment "${a.id}" refers to reference "${a.referenceImageId}"`);
    }
    if (a.fingerprintId !== undefined && a.fingerprintId !== fingerprint.id) {
      fail(`Assessment "${a.id}" refers to fingerprint "${a.fingerprintId}"`);
    }
    const sim = a.designSimilarityIndex;
    if (sim !== null && !(Number.isFinite(sim) && sim >= 0 && sim <= 100)) {
      fail(`Assessment "${a.id}" has out-of-range similarity ${sim}`);
    }
  }
}

function checkResultIntegrity(
  results: RankedSourcingResult[],
  listings: CandidateListing[],
): void {
  const fail = (message: string) => {
    throw new SourcingPipelineError("ranking", message);
  };
  const resultIds = results.map((r) => r.listing.id);
  const duplicate = findDuplicate(resultIds);
  if (duplicate) fail(`Listing "${duplicate}" appears more than once`);

  const expected = new Set(listings.map((l) => l.id));
  if (resultIds.length !== expected.size || !resultIds.every((id) => expected.has(id))) {
    fail("Results do not cover exactly the discovered listings");
  }

  results.forEach((r, index) => {
    if (r.rank !== index + 1) fail(`Result at position ${index + 1} has rank ${r.rank}`);
    if (r.supplier && r.supplier.id !== r.listing.supplierId) {
      fail(`Listing "${r.listing.id}" is associated with the wrong supplier`);
    }
    if (r.assessment && r.assessment.listingId !== r.listing.id) {
      fail(`Listing "${r.listing.id}" is associated with the wrong assessment`);
    }
  });
}
