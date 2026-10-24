import type { DataSourceKind, IsoTimestamp } from "./common";

/**
 * How much we know about a feature:
 * - observed: directly visible in the photograph ("dark wood-look frame").
 * - inferred: a plausible interpretation that is not directly verifiable
 *   ("likely solid oak").
 * - unknown: cannot be determined from the photograph (no value recorded).
 */
export type FeatureCertainty = "observed" | "inferred" | "unknown";

interface FeatureBase {
  /** Open-ended attribute name, e.g. "leg_style", "frame_material". */
  attribute: string;
  /** Why the value is believed, or why it cannot be determined. */
  rationale?: string;
}

export interface KnownFeature extends FeatureBase {
  certainty: "observed" | "inferred";
  value: string;
}

export interface UnknownFeature extends FeatureBase {
  certainty: "unknown";
  value?: never;
}

export type FurnitureFeature = KnownFeature | UnknownFeature;

/**
 * Who or what produced a fingerprint. `kind` is the generation method;
 * `dataSource` says whether the output is synthetic ("mock") or came from a
 * real service ("live"). Both are set by the service implementation, never
 * copied from a model's raw response.
 */
export interface FingerprintSource {
  kind: "manual" | "model" | "fixture";
  dataSource: DataSourceKind;
  /** Model identifier when kind is "model". */
  modelId?: string;
}

/**
 * Structured understanding of the furniture in one or more reference images.
 * Categories and attribute names are open strings to avoid hardcoding a
 * taxonomy. Unverifiable attributes are recorded in the relevant group with
 * certainty "unknown" rather than in a separate list.
 */
export interface FurnitureFingerprint {
  id: string;
  /** One today; more than one when multi-image references are supported. */
  referenceImageIds: [string, ...string[]];
  /** e.g. "chair", "table". */
  category: string;
  /** e.g. "dining_chair", "coffee_table". */
  subtype?: string;
  /** Shape, proportions, construction: legs, arms, back, base, silhouette. */
  structure: FurnitureFeature[];
  /** Visible materials, colours, finishes, upholstery. */
  appearance: FurnitureFeature[];
  /** Details that distinguish this design from others in its category. */
  distinctiveFeatures: FurnitureFeature[];
  /** Text queries for candidate discovery. */
  searchQueries: string[];
  source: FingerprintSource;
  createdAt: IsoTimestamp;
}
