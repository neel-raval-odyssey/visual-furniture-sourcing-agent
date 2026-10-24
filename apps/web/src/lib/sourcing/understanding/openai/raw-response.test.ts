import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import {
  FURNITURE_UNDERSTANDING_INSTRUCTIONS,
  FURNITURE_UNDERSTANDING_USER_PROMPT,
} from "./instructions";
import { RAW_VISION_FORMAT_NAME, rawVisionAnalysisSchema } from "./raw-response";
import { SYNTHETIC_RAW_AMBIGUOUS, SYNTHETIC_RAW_CHAIR, SYNTHETIC_RAW_NO_FURNITURE } from "./test-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any -- malformed runtime data on purpose */

const parse = (value: unknown) => rawVisionAnalysisSchema.safeParse(value);
const withFeature = (patch: Record<string, unknown>) => {
  const raw: any = structuredClone(SYNTHETIC_RAW_CHAIR);
  raw.furniture.structure[0] = { ...raw.furniture.structure[0], ...patch };
  return raw;
};

describe("raw vision response schema", () => {
  it("accepts a furniture analysis", () => {
    expect(parse(SYNTHETIC_RAW_CHAIR).success).toBe(true);
  });

  it("accepts non-furniture and ambiguous outcomes with no furniture object", () => {
    expect(parse(SYNTHETIC_RAW_NO_FURNITURE).success).toBe(true);
    expect(parse(SYNTHETIC_RAW_AMBIGUOUS).success).toBe(true);
  });

  it("accepts unknown features with a null value", () => {
    const unknown = SYNTHETIC_RAW_CHAIR.furniture?.appearance.find((f) => f.certainty === "unknown");
    expect(unknown?.value).toBeNull();
    expect(parse(SYNTHETIC_RAW_CHAIR).success).toBe(true);
  });

  it("rejects a missing category", () => {
    const raw: any = structuredClone(SYNTHETIC_RAW_CHAIR);
    delete raw.furniture.category;
    expect(parse(raw).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["invalid certainty", { certainty: "probably" }],
    ["missing value key", { value: undefined }],
    ["numeric value", { value: 4 }],
    ["extra key", { confidence: 0.9 }],
  ])("rejects a feature with %s", (_name, patch) => {
    expect(parse(withFeature(patch)).success).toBe(false);
  });

  it("rejects an unknown outcome and application-owned fields", () => {
    expect(parse({ ...SYNTHETIC_RAW_NO_FURNITURE, outcome: "maybe_chair" }).success).toBe(false);
    expect(parse({ ...SYNTHETIC_RAW_NO_FURNITURE, id: "fp-1" }).success).toBe(false);
    expect(parse({ ...SYNTHETIC_RAW_NO_FURNITURE, modelId: "gpt-6-luna" }).success).toBe(false);
  });
});

/** Walks the generated JSON Schema and checks Structured Outputs rules. */
function checkStructuredOutputsSubset(node: any, path: string, problems: string[], isRoot = false) {
  if (!node || typeof node !== "object") return;
  if (isRoot && (node.type !== "object" || node.anyOf)) problems.push(`${path}: root must be a plain object`);
  for (const forbidden of ["allOf", "not", "if", "then", "else", "minLength", "maxLength", "oneOf"]) {
    if (forbidden in node) problems.push(`${path}: unsupported keyword ${forbidden}`);
  }
  if (node.type === "object" || node.properties) {
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const keys = Object.keys(node.properties ?? {});
    const required = new Set(node.required ?? []);
    for (const key of keys) if (!required.has(key)) problems.push(`${path}.${key}: must be required`);
    for (const key of keys) checkStructuredOutputsSubset(node.properties[key], `${path}.${key}`, problems);
  }
  if (node.items) checkStructuredOutputsSubset(node.items, `${path}[]`, problems);
  for (const branch of node.anyOf ?? []) checkStructuredOutputsSubset(branch, `${path}|`, problems);
}

describe("Structured Outputs compatibility", () => {
  const format = zodTextFormat(rawVisionAnalysisSchema, RAW_VISION_FORMAT_NAME);

  it("is a strict json_schema format", () => {
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.name).toBe(RAW_VISION_FORMAT_NAME);
  });

  it("stays inside the supported JSON Schema subset", () => {
    const problems: string[] = [];
    checkStructuredOutputsSubset(format.schema, "$", problems, true);
    expect(problems).toEqual([]);
  });

  it("does not ask the model for application-owned fields", () => {
    const schemaText = JSON.stringify(format.schema);
    for (const owned of ["referenceImageIds", "createdAt", "modelId", "dataSource", "provenance", '"id"']) {
      expect(schemaText).not.toContain(owned);
    }
  });
});

describe("instructions", () => {
  it.each([
    ["the four outcomes", /furniture_identified[\s\S]*no_furniture[\s\S]*ambiguous_target[\s\S]*unreadable_image/],
    ["certainty rules", /observed[\s\S]*inferred[\s\S]*unknown[\s\S]*value to null/],
    ["appearance vs composition", /wood-like[\s\S]*solid walnut/],
    ["3 to 5 queries", /3 to 5/],
    ["no brands", /No brand names/],
    ["untrusted image text", /untrusted image content[\s\S]*never as instructions/],
    ["no tools", /Do\s+not\s+browse or use tools/],
  ])("cover %s", (_name, pattern) => {
    expect(FURNITURE_UNDERSTANDING_INSTRUCTIONS).toMatch(pattern);
  });

  it("keeps the user prompt short and free of image content", () => {
    expect(FURNITURE_UNDERSTANDING_USER_PROMPT.length).toBeLessThan(200);
  });
});
