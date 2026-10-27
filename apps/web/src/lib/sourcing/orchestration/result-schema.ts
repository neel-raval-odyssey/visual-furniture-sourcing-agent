import { z } from "zod";
import { summarizeIssues } from "../validation/issues";
import type { SourcingResult } from "./assemble";

/**
 * Boundary validator for result.json (recordType "sourcing_result") when it is
 * read back, e.g. by the web experience. Objects accept additional keys so
 * later additive fields don't break old readers; every field the readers rely
 * on is checked. The parsed value is the SourcingResult written by assemble.ts.
 */

const str = z.string();
const nstr = z.string().nullable();
const nnum = z.number().nullable();

const evidenceItem = z.looseObject({
  feature: str,
  importance: str,
  aspect: str,
  basis: str,
  reference: nstr,
  candidate: nstr,
  explanation: str,
  limitation: nstr,
});

const entry = z.looseObject({
  listingId: str.min(1),
  marketplaceProductId: nstr,
  title: str,
  listingUrl: z.url({ protocol: /^https$/ }),
  product: z.looseObject({
    category: nstr,
    price: z.looseObject({ min: z.number(), max: nnum, currency: nstr, unit: nstr }).nullable(),
    priceTiers: z.array(z.looseObject({ minQuantity: z.number(), maxQuantity: nnum, price: z.number(), currency: nstr })).nullable(),
    minimumOrder: z.looseObject({ quantity: z.number(), unit: nstr }).nullable(),
    attributes: z.record(str, str).nullable(),
    missingFields: z.array(str),
  }),
  supplier: z
    .looseObject({
      id: str,
      name: str,
      profileUrl: nstr,
      countryCode: nstr,
      location: nstr,
      classification: nstr,
      marketplaceClaims: z.array(str),
      platformTenureYears: nnum,
      missingFields: z.array(str),
    })
    .nullable(),
  provenance: z.looseObject({ acquisitionMethod: str, providerId: nstr, providerAccess: nstr, providerRunIds: z.array(str), capturedAt: str }),
  imageEvidence: z.looseObject({
    status: str,
    image: z
      .looseObject({ ref: str, uri: str, sha256: z.string().regex(/^[0-9a-f]{64}$/), mimeType: str, width: z.number(), height: z.number(), fallback: z.boolean() })
      .nullable(),
    problems: z.array(z.looseObject({ ref: str, problem: str, message: str })),
  }),
  retrieval: z.looseObject({ siglipRank: nnum, embeddingCosineSimilarity: nnum }),
  verification: z.looseObject({
    status: str,
    selected: z.boolean(),
    selectionNote: str,
    verificationRank: nnum,
    designSimilarityIndex: z.number().min(0).max(100).nullable(),
    classification: nstr,
    confidence: nstr,
    summary: nstr,
    matches: z.array(evidenceItem),
    partialStructuralDifferences: z.array(evidenceItem),
    structuralMismatches: z.array(evidenceItem),
    appearanceDifferences: z.array(evidenceItem),
    limitations: z.array(str),
    uncertainClaims: z.array(str),
    model: nstr,
    instructionsVersion: nstr,
    record: nstr,
    notes: z.array(str),
  }),
});

export const sourcingResultSchema = z.looseObject({
  recordType: z.literal("sourcing_result"),
  schemaVersion: z.literal(1),
  runId: str.min(1),
  caseId: str.min(1),
  createdAt: str,
  synthetic: z.boolean(),
  reference: z.looseObject({ referenceImageId: str, sha256: str, fingerprintId: str, fingerprintModel: nstr, category: str, subtype: nstr }),
  source: z.looseObject({
    kind: str,
    label: str,
    acquisitionMethod: str,
    providers: z.array(z.looseObject({ providerId: str, access: str, source: str })),
    manifestSha256: str,
    discovery: z.unknown().nullable(),
  }),
  stages: z.record(str, z.looseObject({ state: str, message: nstr })),
  counts: z.looseObject({
    candidates: z.number(),
    withLocalImage: z.number(),
    withoutUsableImage: z.number(),
    shortlisted: z.number(),
    verified: z.number(),
    abstained: z.number(),
    unverified: z.number(),
  }),
  ordering: str,
  models: z.looseObject({
    siglip: z.looseObject({ id: str, revision: str, source: nstr, createdAt: nstr }).nullable(),
    sol: z.looseObject({ model: str, instructionsVersion: str, imageDetail: str, reasoningEffort: str }),
  }),
  selection: z.looseObject({ policy: str, excluded: z.array(z.unknown()), paidRequestsNeeded: z.number() }),
  recordedUsage: z.looseObject({ solResponses: z.number(), inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number() }),
  externalRequestsMade: z.literal(0),
  verified: z.array(entry),
  abstained: z.array(entry),
  unverified: z.array(entry),
  warnings: z.array(str),
  followUps: z.array(str),
});

export class SourcingResultError extends Error {}

export function parseSourcingResult(raw: unknown): SourcingResult {
  const parsed = sourcingResultSchema.safeParse(raw);
  if (!parsed.success) throw new SourcingResultError(`result.json is invalid: ${summarizeIssues(parsed.error)}`);
  const r = parsed.data;
  const ids = [...r.verified, ...r.abstained, ...r.unverified].map((e) => e.listingId);
  if (new Set(ids).size !== ids.length) throw new SourcingResultError("result.json lists a candidate more than once");
  if (ids.length !== r.counts.candidates) throw new SourcingResultError("result.json candidate count does not match its entries");
  return r as unknown as SourcingResult;
}
