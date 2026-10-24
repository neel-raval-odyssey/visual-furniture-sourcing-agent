import type { RawVisionAnalysis } from "./raw-response";

/**
 * TEST FIXTURES: synthetic raw model responses, written by hand. They are not
 * real GPT-6 Luna output.
 */

export const SYNTHETIC_RAW_CHAIR: RawVisionAnalysis = {
  outcome: "furniture_identified",
  outcome_reason: "A single dining chair is the clear subject.",
  furniture: {
    category: "Chair",
    subtype: "Dining Chair",
    structure: [
      { attribute: "Backrest Shape", certainty: "observed", value: "  single curved   panel ", rationale: null },
      { attribute: "leg_count", certainty: "observed", value: "4", rationale: null },
      { attribute: "rear_legs", certainty: "unknown", value: null, rationale: "Hidden behind the seat." },
    ],
    appearance: [
      { attribute: "frame_colour", certainty: "observed", value: "dark brown wood-like", rationale: null },
      { attribute: "frame_material", certainty: "inferred", value: "solid wood", rationale: "Visible grain; could be veneer." },
      { attribute: "wood_species", certainty: "unknown", value: null, rationale: "Not determinable from a photo." },
    ],
    distinctive_features: [
      { attribute: "backrest_curve", certainty: "observed", value: "deep continuous curve", rationale: null },
    ],
    search_queries: [
      "curved back dining chair",
      "Curved Back Dining Chair",
      "  wooden   curved backrest chair ",
      "",
      "dark wood dining chair",
      "bentwood dining chair",
      "mid century dining chair",
      "one too many",
    ],
  },
};

export const SYNTHETIC_RAW_NO_FURNITURE: RawVisionAnalysis = {
  outcome: "no_furniture",
  outcome_reason: "The image shows a mountain landscape.",
  furniture: null,
};

export const SYNTHETIC_RAW_AMBIGUOUS: RawVisionAnalysis = {
  outcome: "ambiguous_target",
  outcome_reason: "A sofa, two armchairs and a table are equally prominent.",
  furniture: null,
};
