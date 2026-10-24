import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImageInputError } from "../image-input/image-content";
import { TEST_PNG } from "../image-input/test-fixtures";
import { FurnitureNotIdentifiedError, VisionModelError } from "../understanding/openai/errors";
import { FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } from "../understanding/openai/instructions";
import { mapRawAnalysisToFingerprint } from "../understanding/openai/mapping";
import { SYNTHETIC_RAW_CHAIR } from "../understanding/openai/test-fixtures";
import { DEFAULT_IMAGE_UNDERSTANDING_MODEL, DEFAULT_VISION_REQUEST_SETTINGS } from "../understanding/openai/vision-client";
import { evaluationCaseSchema, evaluationDatasetSchema, localImageMapSchema } from "./dataset";
import { createReviewSkeleton, reviewRecordSchema } from "./review";
import { buildRunRecord, runRecordSchema, sha256Hex, type BuildRunRecordInput } from "./run-record";

/* eslint-disable @typescript-eslint/no-explicit-any -- malformed runtime data on purpose */

const repoFile = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../../${path}`, import.meta.url)), "utf8"));
const baselineDataset = repoFile("evals/image-understanding/dataset.json");
const syntheticDataset = repoFile("evals/image-understanding/synthetic/dataset.json");
const ettrick = baselineDataset.cases[0];

const issues = (schema: { safeParse: (v: unknown) => any }, value: unknown): string[] => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`);
};
const withCase = (patch: (c: any) => void) => {
  const c = structuredClone(ettrick);
  patch(c);
  return c;
};

describe("evaluation dataset", () => {
  it("accepts the shareable baseline dataset and the synthetic dataset", () => {
    expect(issues(evaluationDatasetSchema, baselineDataset)).toEqual([]);
    expect(issues(evaluationDatasetSchema, syntheticDataset)).toEqual([]);
  });

  it("pins the baseline to the current model settings and instruction version", () => {
    expect(baselineDataset.baseline).toEqual({
      model: DEFAULT_IMAGE_UNDERSTANDING_MODEL,
      instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION,
      imageDetail: DEFAULT_VISION_REQUEST_SETTINGS.imageDetail,
      reasoningEffort: DEFAULT_VISION_REQUEST_SETTINGS.reasoningEffort,
      maxOutputTokens: DEFAULT_VISION_REQUEST_SETTINGS.maxOutputTokens,
    });
  });

  it("represents the Ettrick bed as a provisional case without a local path", () => {
    expect(ettrick).toMatchObject({ id: "ettrick-bed", annotationStatus: "provisional", expected: { outcome: "furniture_identified", category: "bed" } });
    expect(JSON.stringify(baselineDataset)).not.toMatch(/\/Users\/|\.png/);
  });

  it("marks the synthetic dataset as a tooling test", () => {
    expect(syntheticDataset.purpose).toBe("tooling_test");
  });

  it.each<[string, (c: any) => void, RegExp]>([
    ["a missing id", (c) => delete c.id, /^id:/],
    ["an invalid id", (c) => (c.id = "Ettrick Bed"), /^id:/],
    ["an invalid condition tag", (c) => (c.conditions = ["blurry"]), /^conditions/],
    ["no condition tags", (c) => (c.conditions = []), /^conditions/],
    ["duplicate condition tags", (c) => (c.conditions = ["low_light", "low_light"]), /Duplicate condition/],
    ["a non_furniture tag on a furniture case", (c) => (c.conditions = ["non_furniture"]), /cannot be tagged "non_furniture"/],
    ["no critical feature in a provisional case", (c) => (c.expected.features = c.expected.features.filter((f: any) => f.priority !== "critical")), /needs at least one critical feature/],
    ["duplicate feature ids", (c) => c.expected.features.push({ ...c.expected.features[0] }), /Duplicate feature id/],
    ["a feature without a priority", (c) => delete c.expected.features[0].priority, /priority/],
    ["an invalid image hash", (c) => (c.imageSha256 = "abc"), /imageSha256/],
  ])("rejects a case with %s", (_name, patch, message) => {
    expect(issues(evaluationCaseSchema, withCase(patch)).join("\n")).toMatch(message);
  });

  it("allows a draft furniture case without features", () => {
    expect(issues(evaluationCaseSchema, withCase((c) => {
      c.annotationStatus = "draft";
      c.expected.features = [];
    }))).toEqual([]);
  });

  it("rejects furniture fields on a non-furniture case", () => {
    const nonFurniture = withCase((c) => {
      c.conditions = ["non_furniture"];
      c.expected = { outcome: "no_furniture", category: "bed", features: [] };
    });
    expect(issues(evaluationCaseSchema, nonFurniture).join("\n")).toMatch(/Unrecognized key/);
  });

  it("accepts a non-furniture case with no category and rejects contradictory alternatives", () => {
    const base = withCase((c) => {
      c.conditions = ["non_furniture"];
      c.expected = { outcome: "no_furniture", alsoAcceptableOutcomes: ["unreadable_image"] };
    });
    expect(issues(evaluationCaseSchema, base)).toEqual([]);
    expect(issues(evaluationCaseSchema, { ...base, expected: { outcome: "no_furniture", alsoAcceptableOutcomes: ["furniture_identified"] } }).join()).toMatch(/cannot accept furniture_identified/);
    expect(issues(evaluationCaseSchema, { ...base, expected: { outcome: "no_furniture", alsoAcceptableOutcomes: ["no_furniture"] } }).join()).toMatch(/Repeats the expected outcome/);
  });

  it("rejects duplicate case ids and an empty dataset", () => {
    expect(issues(evaluationDatasetSchema, { ...baselineDataset, cases: [ettrick, ettrick] }).join()).toMatch(/Duplicate case id "ettrick-bed"/);
    expect(issues(evaluationDatasetSchema, { ...baselineDataset, cases: [] }).length).toBeGreaterThan(0);
  });

  it("validates the private image mapping", () => {
    expect(issues(localImageMapSchema, { schemaVersion: 1, images: { "ettrick-bed": "/path/to/ettrick.png" } })).toEqual([]);
    expect(issues(localImageMapSchema, { schemaVersion: 1, images: { "Bad Id": "x.png" } }).length).toBeGreaterThan(0);
  });
});

const reference = { id: "ref-local-0123456789abcdef" };
const recordInput = (outcome: BuildRunRecordInput["outcome"]): BuildRunRecordInput => ({
  caseId: "ettrick-bed",
  recordedAt: "2026-10-24T10:00:00.000Z",
  dataSource: "live",
  image: { bytes: TEST_PNG, mimeType: "image/png" },
  referenceId: reference.id,
  settings: { ...DEFAULT_VISION_REQUEST_SETTINGS, model: "gpt-6-luna" },
  instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION,
  durationMs: 1234,
  outcome,
});
const liveFingerprint = () =>
  mapRawAnalysisToFingerprint(SYNTHETIC_RAW_CHAIR, { ...reference, image: { uri: "x" }, origin: { kind: "unknown" }, submittedAt: "2026-10-24T09:59:00.000Z" }, {
    fingerprintId: "fp-1",
    createdAt: "2026-10-24T10:00:00.000Z",
    modelId: "gpt-6-luna-2026-10-01",
  });
const meta = { responseId: "resp_1", responseModel: "gpt-6-luna-2026-10-01", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };

describe("run records", () => {
  it("records a furniture result with settings, usage, image hash and no image bytes", () => {
    const record = buildRunRecord(recordInput({ ok: true, details: { fingerprint: liveFingerprint(), responseId: "resp_1", usage: meta.usage } }));

    expect(issues(runRecordSchema, record)).toEqual([]);
    expect(record.result.kind).toBe("furniture_identified");
    expect(record.request).toMatchObject({ model: "gpt-6-luna", instructionsVersion: "2026-10-24.1", imageDetail: "high", reasoningEffort: "low" });
    expect(record.response).toEqual({ responseId: "resp_1", responseModel: "gpt-6-luna-2026-10-01", usage: meta.usage, durationMs: 1234 });
    expect(record.image).toEqual({ sha256: sha256Hex(TEST_PNG), mimeType: "image/png", bytes: TEST_PNG.length });
    expect(JSON.stringify(record)).not.toContain(Buffer.from(TEST_PNG).toString("base64"));
  });

  it("records a correct rejection as not_identified, keeping its usage", () => {
    const error = new FurnitureNotIdentifiedError("no_furniture", "A landscape.");
    error.response = meta;
    const record = buildRunRecord(recordInput({ ok: false, error }));

    expect(record.result).toEqual({ kind: "not_identified", modelOutcome: "no_furniture", modelReason: "A landscape." });
    expect(record.response.usage).toEqual(meta.usage);
    expect(issues(runRecordSchema, record)).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["a model error", new VisionModelError("rate_limit", "Rate limit or quota exceeded (429)", { status: 429, requestId: "req_1" }), "rate_limit"],
    ["a refusal", new VisionModelError("refusal", "Model refused to analyse the image"), "refusal"],
    ["an image input error", new ImageInputError("unknown_reference", "No image content"), "image_input"],
    ["an unknown error, keeping only its name", new TypeError("secret sk-test-123"), "unexpected"],
  ])("records %s as an error result", (_name, error, category) => {
    const record = buildRunRecord(recordInput({ ok: false, error }));
    expect(record.result).toMatchObject({ kind: "error", errorCategory: category });
    expect(JSON.stringify(record)).not.toContain("sk-test-123");
    expect(issues(runRecordSchema, record)).toEqual([]);
  });

  it("accepts records without usage and rejects inconsistent ones", () => {
    const record: any = buildRunRecord(recordInput({ ok: true, details: { fingerprint: liveFingerprint(), responseId: "resp_1" } }));
    expect(record.response.usage).toBeNull();
    expect(issues(runRecordSchema, record)).toEqual([]);

    expect(issues(runRecordSchema, { ...record, dataSource: "mock" }).join()).toMatch(/Does not match record dataSource/);
    expect(issues(runRecordSchema, { ...record, referenceId: "ref-other" }).join()).toMatch(/Does not include referenceId/);
    expect(issues(runRecordSchema, { ...record, result: { kind: "maybe" } }).length).toBeGreaterThan(0);
    expect(issues(runRecordSchema, { ...record, imageBase64: "AAAA" }).join()).toMatch(/Unrecognized key/);
    expect(issues(runRecordSchema, { ...record, caseId: "Not A Slug" }).length).toBeGreaterThan(0);
  });
});

describe("review records", () => {
  it("creates a blank skeleton that does not count as a review", () => {
    const skeleton = createReviewSkeleton(evaluationCaseSchema.parse(ettrick), "resp_1");
    expect(issues(reviewRecordSchema, skeleton)).toEqual([]);
    expect(skeleton.status).toBe("in_progress");
    expect(skeleton.features.map((f) => f.featureId)).toEqual(ettrick.expected.features.map((f: any) => f.id));
    expect(skeleton.features.every((f) => f.judgement === "not_reviewed")).toBe(true);
  });

  it("requires a reviewer and time for complete reviews", () => {
    const skeleton = createReviewSkeleton(evaluationCaseSchema.parse(ettrick), null);
    expect(issues(reviewRecordSchema, { ...skeleton, status: "complete" }).join()).toMatch(/needs a reviewer[\s\S]*needs reviewedAt/);
  });

  it("rejects invalid ratings, judgements and duplicate features", () => {
    const skeleton: any = createReviewSkeleton(evaluationCaseSchema.parse(ettrick), null);
    expect(issues(reviewRecordSchema, { ...skeleton, searchQueries: { ...skeleton.searchQueries, rating: 6 } }).length).toBeGreaterThan(0);
    expect(issues(reviewRecordSchema, { ...skeleton, features: [{ featureId: "x", judgement: "great" }] }).length).toBeGreaterThan(0);
    expect(issues(reviewRecordSchema, { ...skeleton, features: [skeleton.features[0], skeleton.features[0]] }).join()).toMatch(/Duplicate featureId/);
  });
});
