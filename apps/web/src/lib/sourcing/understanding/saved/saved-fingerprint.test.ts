import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveShapedRunRecord, REPO_ROOT, syntheticRunRecord } from "../../discovery/curated/test-fixtures";
import {
  loadSavedFingerprint,
  SavedFingerprintImageUnderstandingService,
  savedFingerprintFromRecord,
  SavedRunError,
} from "./saved-fingerprint";

const predictions = `${REPO_ROOT}evals/image-understanding/synthetic/predictions`;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-saved-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function problemOf(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SavedRunError);
  return (error as SavedRunError).problem;
}

describe("saved fingerprints", () => {
  it("loads a valid saved run and keeps model provenance", async () => {
    const saved = await loadSavedFingerprint(join(predictions, "syn-bed-001.json"), "syn-bed-001");
    expect(saved.fingerprint.id).toBe("fp-synthetic-syn-bed-001");
    expect(saved.fingerprint.source.dataSource).toBe("mock");
    expect(saved.reference).toMatchObject({ id: "ref-local-0ef9571d83494cd6", origin: { kind: "unknown" } });
    expect(saved.reference.image.uri).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts a live-shaped record without changing its fingerprint", () => {
    const raw = liveShapedRunRecord();
    const saved = savedFingerprintFromRecord(raw, "test-live-bed");
    expect(saved.fingerprint).toEqual((raw as { result: { fingerprint: unknown } }).result.fingerprint);
    expect(saved.fingerprint.source).toEqual({ kind: "model", dataSource: "live", modelId: "gpt-6-luna" });
  });

  it("reports missing, malformed and invalid records explicitly", async () => {
    expect(await problemOf(loadSavedFingerprint(join(dir, "none.json"), "x"))).toBe("missing_record");
    expect(await problemOf(loadSavedFingerprint(join(predictions, "broken.json"), "broken"))).toBe("malformed_json");
    await writeFile(join(dir, "invalid.json"), JSON.stringify({ recordType: "image_understanding_run" }));
    expect(await problemOf(loadSavedFingerprint(join(dir, "invalid.json"), "x"))).toBe("invalid_record");
    const tampered = syntheticRunRecord() as { result: { fingerprint: { source: { dataSource: string } } } };
    tampered.result.fingerprint.source.dataSource = "live"; // no longer matches the record's dataSource
    expect(() => savedFingerprintFromRecord(tampered, "syn-bed-001")).toThrow(/not a valid run record/);
  });

  it("refuses records for another case, non-furniture outcomes and model errors", async () => {
    expect(await problemOf(loadSavedFingerprint(join(predictions, "syn-bed-001.json"), "syn-chair-001"))).toBe("case_mismatch");
    expect(await problemOf(loadSavedFingerprint(join(predictions, "syn-landscape-001.json"), "syn-landscape-001"))).toBe("not_identified");
    expect(await problemOf(loadSavedFingerprint(join(predictions, "syn-sofa-001.json"), "syn-sofa-001"))).toBe("model_error");
  });

  it("replays the fingerprint only for its own reference", async () => {
    const saved = await loadSavedFingerprint(join(predictions, "syn-bed-001.json"), "syn-bed-001");
    const service = new SavedFingerprintImageUnderstandingService(saved.fingerprint);
    await expect(service.analyze(saved.reference)).resolves.toEqual(saved.fingerprint);
    await expect(service.analyze({ ...saved.reference, id: "ref-other" })).rejects.toThrow(/does not belong/);
  });
});
