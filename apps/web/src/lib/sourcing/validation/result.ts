import { z } from "zod";
import type { RankedSourcingResult } from "../domain";
import { visualMatchAssessmentSchema } from "./assessment";
import type { Assert, SchemaMatches } from "./contract";
import { candidateListingSchema } from "./listing";
import { supplierProfileSchema } from "./supplier";

/**
 * Structure only. Rank order, coverage and association checks belong to the
 * pipeline's integrity rules.
 */
export const rankedSourcingResultSchema = z.strictObject({
  listing: candidateListingSchema,
  supplier: supplierProfileSchema.optional(),
  assessment: visualMatchAssessmentSchema.optional(),
  rank: z.int().positive().optional(),
});

export type _RankedSourcingResultCheck = Assert<SchemaMatches<typeof rankedSourcingResultSchema, RankedSourcingResult>>;
