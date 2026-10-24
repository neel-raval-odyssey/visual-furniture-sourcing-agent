import { describe, expect, it } from "vitest";
import type { ReferenceImage } from "../../domain";
import { furnitureFingerprintSchema } from "../../validation/fingerprint";
import { FurnitureNotIdentifiedError, VisionModelError } from "./errors";
import { mapRawAnalysisToFingerprint, MAX_SEARCH_QUERIES, normalizeSearchQueries, toSnakeCase } from "./mapping";
import type { RawVisionAnalysis } from "./raw-response";
import { SYNTHETIC_RAW_AMBIGUOUS, SYNTHETIC_RAW_CHAIR, SYNTHETIC_RAW_NO_FURNITURE } from "./test-fixtures";

const reference: ReferenceImage = {
  id: "ref-local-0123456789abcdef",
  image: { uri: "local-file:sha256-0123456789abcdef", mimeType: "image/jpeg" },
  origin: { kind: "unknown" },
  submittedAt: "2026-10-24T09:59:00.000Z",
};
const trusted = { fingerprintId: "fp-test-1", createdAt: "2026-10-24T10:00:00.000Z", modelId: "gpt-6-luna" };
const map = (raw: RawVisionAnalysis) => mapRawAnalysisToFingerprint(raw, reference, trusted);

const withChair = (edit: (raw: RawVisionAnalysis & { furniture: NonNullable<RawVisionAnalysis["furniture"]> }) => void) => {
  const raw = structuredClone(SYNTHETIC_RAW_CHAIR) as RawVisionAnalysis & { furniture: NonNullable<RawVisionAnalysis["furniture"]> };
  edit(raw);
  return raw;
};

describe("mapRawAnalysisToFingerprint", () => {
  const fingerprint = map(SYNTHETIC_RAW_CHAIR);

  it("produces a fingerprint that passes the existing runtime schema", () => {
    expect(furnitureFingerprintSchema.safeParse(fingerprint).success).toBe(true);
  });

  it("assigns application-owned identity, association, timestamp and provenance", () => {
    expect(fingerprint.id).toBe("fp-test-1");
    expect(fingerprint.referenceImageIds).toEqual([reference.id]);
    expect(fingerprint.createdAt).toBe("2026-10-24T10:00:00.000Z");
    expect(fingerprint.source).toEqual({ kind: "model", dataSource: "live", modelId: "gpt-6-luna" });
  });

  it("normalizes category and subtype", () => {
    expect(fingerprint.category).toBe("chair");
    expect(fingerprint.subtype).toBe("dining_chair");
  });

  it("maps structure, appearance and distinctive features with their certainty", () => {
    expect(fingerprint.structure[0]).toEqual({ attribute: "backrest_shape", certainty: "observed", value: "single curved panel" });
    expect(fingerprint.appearance[1]).toEqual({
      attribute: "frame_material",
      certainty: "inferred",
      value: "solid wood",
      rationale: "Visible grain; could be veneer.",
    });
    expect(fingerprint.distinctiveFeatures).toEqual([
      { attribute: "backrest_curve", certainty: "observed", value: "deep continuous curve" },
    ]);
  });

  it("maps unknown features without a value", () => {
    const unknown = fingerprint.appearance[2];
    expect(unknown).toEqual({ attribute: "wood_species", certainty: "unknown", rationale: "Not determinable from a photo." });
    expect(unknown).not.toHaveProperty("value");
  });

  it("normalizes, de-duplicates and caps search queries", () => {
    expect(fingerprint.searchQueries).toEqual([
      "curved back dining chair",
      "wooden curved backrest chair",
      "dark wood dining chair",
      "bentwood dining chair",
      "mid century dining chair",
    ]);
    expect(fingerprint.searchQueries.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES);
  });

  it("omits a null or blank subtype rather than inventing one", () => {
    const fp = map(withChair((raw) => (raw.furniture.subtype = null)));
    expect(fp).not.toHaveProperty("subtype");
  });

  it("does not let model text override application-owned fields", () => {
    const fp = map(withChair((raw) => (raw.furniture.category = "chair")));
    expect(fp.id).toBe(trusted.fingerprintId);
    expect(fp.source.dataSource).toBe("live");
  });

  it.each([
    ["no_furniture", SYNTHETIC_RAW_NO_FURNITURE],
    ["ambiguous_target", SYNTHETIC_RAW_AMBIGUOUS],
  ] as const)("refuses to build a fingerprint for %s", (outcome, raw) => {
    expect(() => map(raw)).toThrow(FurnitureNotIdentifiedError);
    try {
      map(raw);
    } catch (error) {
      expect((error as FurnitureNotIdentifiedError).outcome).toBe(outcome);
    }
  });

  it("ignores a furniture object attached to a non-furniture outcome", () => {
    const raw = { ...SYNTHETIC_RAW_CHAIR, outcome: "unreadable_image" as const };
    expect(() => map(raw)).toThrow(FurnitureNotIdentifiedError);
  });

  it.each<[string, Parameters<typeof withChair>[0], RegExp]>([
    ["furniture missing for an identified outcome", (raw) => ((raw as RawVisionAnalysis).furniture = null), /furniture/],
    ["blank category", (raw) => (raw.furniture.category = "  "), /category/],
    ["unknown feature with a value", (raw) => (raw.furniture.appearance[2].value = "walnut"), /appearance\[2\]\.value: unknown feature has a value/],
    ["observed feature without a value", (raw) => (raw.furniture.structure[1].value = null), /structure\[1\]\.value/],
    ["inferred feature with a blank value", (raw) => (raw.furniture.appearance[1].value = " "), /appearance\[1\]\.value/],
    ["blank attribute name", (raw) => (raw.furniture.structure[0].attribute = "!!"), /structure\[0\]\.attribute/],
  ])("rejects %s as malformed output", (_name, edit, message) => {
    const run = () => map(withChair(edit));
    expect(run).toThrow(VisionModelError);
    expect(run).toThrow(message);
  });
});

describe("normalization helpers", () => {
  it("converts attribute names to snake_case", () => {
    expect(toSnakeCase(" Leg Style ")).toBe("leg_style");
    expect(toSnakeCase("back-rest/shape")).toBe("back_rest_shape");
  });

  it("returns no queries rather than inventing them", () => {
    expect(normalizeSearchQueries(["", "  "])).toEqual([]);
  });
});
