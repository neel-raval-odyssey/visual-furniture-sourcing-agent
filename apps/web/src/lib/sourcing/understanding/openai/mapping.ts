import type { FurnitureFeature, FurnitureFingerprint, ReferenceImage } from "../../domain";
import { FurnitureNotIdentifiedError, VisionModelError } from "./errors";
import type { RawFeature, RawVisionAnalysis } from "./raw-response";

export const MAX_SEARCH_QUERIES = 5;

/** Application-owned values. Never taken from model output. */
export interface TrustedFingerprintMetadata {
  fingerprintId: string;
  createdAt: string;
  modelId: string;
}

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

/** "Backrest Shape" / "backrest-shape" → "backrest_shape". */
export function toSnakeCase(text: string): string {
  return collapse(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Trims, lower-cases, de-duplicates and caps the query list. */
export function normalizeSearchQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of queries) {
    const query = collapse(raw).toLowerCase();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    result.push(query);
    if (result.length === MAX_SEARCH_QUERIES) break;
  }
  return result;
}

function malformed(path: string, problem: string): VisionModelError {
  return new VisionModelError("malformed_output", `Model output is inconsistent at ${path}: ${problem}`);
}

function mapFeature(raw: RawFeature, path: string): FurnitureFeature {
  const attribute = toSnakeCase(raw.attribute);
  if (!attribute) throw malformed(`${path}.attribute`, "empty attribute name");

  const rationale = raw.rationale === null ? "" : collapse(raw.rationale);
  const withRationale = rationale ? { rationale } : {};

  if (raw.certainty === "unknown") {
    // An unknown feature must not carry a value. Rejected, not silently dropped.
    if (raw.value !== null && collapse(raw.value) !== "") {
      throw malformed(`${path}.value`, "unknown feature has a value");
    }
    return { attribute, certainty: "unknown", ...withRationale };
  }

  const value = raw.value === null ? "" : collapse(raw.value);
  if (!value) throw malformed(`${path}.value`, `${raw.certainty} feature has no value`);
  return { attribute, certainty: raw.certainty, value, ...withRationale };
}

const mapFeatures = (features: readonly RawFeature[], path: string) =>
  features.map((f, i) => mapFeature(f, `${path}[${i}]`));

/**
 * Turns structurally valid model output into a FurnitureFingerprint. Trusted
 * fields (id, reference association, timestamp, provenance) come from the
 * application. Throws FurnitureNotIdentifiedError for non-furniture outcomes
 * and VisionModelError("malformed_output") for inconsistent output; nothing
 * is invented to fill gaps.
 */
export function mapRawAnalysisToFingerprint(
  analysis: RawVisionAnalysis,
  reference: ReferenceImage,
  trusted: TrustedFingerprintMetadata,
): FurnitureFingerprint {
  if (analysis.outcome !== "furniture_identified") {
    throw new FurnitureNotIdentifiedError(analysis.outcome, collapse(analysis.outcome_reason));
  }
  const furniture = analysis.furniture;
  if (!furniture) throw malformed("furniture", "outcome is furniture_identified but furniture is null");

  const category = toSnakeCase(furniture.category);
  if (!category) throw malformed("furniture.category", "empty category");
  const subtype = furniture.subtype === null ? "" : toSnakeCase(furniture.subtype);

  return {
    id: trusted.fingerprintId,
    referenceImageIds: [reference.id],
    category,
    ...(subtype ? { subtype } : {}),
    structure: mapFeatures(furniture.structure, "furniture.structure"),
    appearance: mapFeatures(furniture.appearance, "furniture.appearance"),
    distinctiveFeatures: mapFeatures(furniture.distinctive_features, "furniture.distinctive_features"),
    searchQueries: normalizeSearchQueries(furniture.search_queries),
    source: { kind: "model", dataSource: "live", modelId: trusted.modelId },
    createdAt: trusted.createdAt,
  };
}
