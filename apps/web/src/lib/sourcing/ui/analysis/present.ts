import type { FurnitureFeature, FurnitureFingerprint } from "../../domain";
import { humanize } from "../labels";
import type { AnalysisAttempt } from "./attempts";

/**
 * Plain-English views of a saved fingerprint and of attempt outcomes for the
 * simple upload page. Values are quoted from the validated fingerprint;
 * nothing is rewritten or invented.
 */

export interface PlainFeature {
  label: string;
  value: string | null;
  /** "likely" for inferred features; "not visible" for unknown ones. */
  qualifier: "likely" | "not visible" | null;
  note: string | null;
}

const plain = (f: FurnitureFeature): PlainFeature => ({
  label: humanize(f.attribute),
  value: f.certainty === "unknown" ? null : f.value,
  qualifier: f.certainty === "inferred" ? "likely" : f.certainty === "unknown" ? "not visible" : null,
  note: f.certainty === "observed" ? null : (f.rationale ?? null),
});

const known = (features: FurnitureFeature[]) => [...features.filter((f) => f.certainty === "observed"), ...features.filter((f) => f.certainty === "inferred")];

export interface FurnitureSummary {
  type: string;
  subtype: string | null;
  distinctive: PlainFeature[];
  structure: PlainFeature[];
  appearance: PlainFeature[];
  /** Details the photo could not show. */
  uncertain: PlainFeature[];
  all: { title: string; features: PlainFeature[] }[];
}

export function summarizeFingerprint(fp: FurnitureFingerprint, max = 4): FurnitureSummary {
  return {
    type: humanize(fp.category),
    subtype: fp.subtype ? humanize(fp.subtype) : null,
    distinctive: known(fp.distinctiveFeatures).slice(0, max).map(plain),
    structure: known(fp.structure).slice(0, max).map(plain),
    appearance: known(fp.appearance).slice(0, max).map(plain),
    uncertain: [...fp.structure, ...fp.appearance, ...fp.distinctiveFeatures].filter((f) => f.certainty === "unknown").slice(0, 3).map(plain),
    all: [
      { title: "Distinctive details", features: fp.distinctiveFeatures.map(plain) },
      { title: "Shape and structure", features: fp.structure.map(plain) },
      { title: "Colour, materials and finish", features: fp.appearance.map(plain) },
    ],
  };
}

export const NOT_IDENTIFIED_TEXT: Record<string, { title: string; body: string }> = {
  no_furniture: { title: "We couldn't identify a clear furniture item in this photo.", body: "Nothing was saved as a furniture reference. Try a photo where one piece of furniture is clearly the subject." },
  ambiguous_target: {
    title: "This photo shows several pieces, and none stands out as the main one.",
    body: "Nothing was saved as a furniture reference. Try a photo that focuses on the one piece you want to find.",
  },
  unreadable_image: { title: "The photo was too unclear to analyze.", body: "Nothing was saved as a furniture reference. Try a sharper, well-lit photo." },
};

const FAILED_TEXT: Record<string, string> = {
  refusal: "The AI declined to analyze this photo.",
  incomplete: "The analysis came back incomplete, so nothing was saved.",
  missing_output: "The analysis came back empty, so nothing was saved.",
  malformed_output: "The analysis came back in an unexpected form, so nothing was saved.",
  authentication: "OpenAI didn't accept the API key configured on this computer.",
  permission: "The configured OpenAI account doesn't have access to this model.",
  model_not_found: "The analysis model isn't available to the configured OpenAI account.",
  rate_limit: "The OpenAI usage limit or quota was reached.",
  bad_request: "OpenAI couldn't process this photo.",
  server_error: "OpenAI had a server problem.",
};

export const UNCERTAIN_TEXT = "The analysis couldn't be confirmed. A request may already have been sent. Review the attempt before trying again.";

export const TRY_AGAIN_TEXT =
  "To try again, upload the photo again. That starts a new analysis, which needs its own confirmation and may be charged again.";

export function failureText(a: AnalysisAttempt): string {
  return (a.outcome?.errorCategory && FAILED_TEXT[a.outcome.errorCategory]) || "The analysis didn't succeed, so nothing was saved.";
}
