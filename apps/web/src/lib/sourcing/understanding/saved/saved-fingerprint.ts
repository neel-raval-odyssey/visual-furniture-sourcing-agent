import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FurnitureFingerprint, ReferenceImage } from "../../domain";
import { runRecordSchema, type RunRecord } from "../../evaluation/run-record";
import { summarizeIssues } from "../../validation/issues";
import type { ImageUnderstandingService } from "../types";

/**
 * Reuses a fingerprint saved by `analyze:image --output` instead of making
 * another paid model request. The record is validated with the existing
 * evaluation schema; nothing in it is repaired or filled in.
 */

export type SavedRunProblem =
  | "missing_record"
  | "unreadable_record"
  | "malformed_json"
  | "invalid_record"
  | "case_mismatch"
  | "not_identified"
  | "model_error";

export class SavedRunError extends Error {
  constructor(
    readonly problem: SavedRunProblem,
    message: string,
  ) {
    super(message);
    this.name = "SavedRunError";
  }
}

export interface SavedFingerprint {
  caseId: string;
  record: RunRecord;
  fingerprint: FurnitureFingerprint;
  /** Reference rebuilt from the record. Holds the image hash, never a path or bytes. */
  reference: ReferenceImage;
}

/** Validates a parsed run record and extracts its fingerprint for one case. */
export function savedFingerprintFromRecord(raw: unknown, caseId: string, label = "run record"): SavedFingerprint {
  const parsed = runRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SavedRunError("invalid_record", `${label} is not a valid run record: ${summarizeIssues(parsed.error)}`);
  }
  const record = parsed.data;
  if (record.caseId !== caseId) {
    throw new SavedRunError("case_mismatch", `${label} belongs to case "${record.caseId ?? "none"}", not "${caseId}"`);
  }
  const result = record.result;
  if (result.kind === "not_identified") {
    throw new SavedRunError(
      "not_identified",
      `${label} has no fingerprint: the model reported ${result.modelOutcome}. Candidate discovery needs a furniture fingerprint.`,
    );
  }
  if (result.kind === "error") {
    throw new SavedRunError("model_error", `${label} has no fingerprint: the run failed (${result.errorCategory}).`);
  }
  return {
    caseId,
    record,
    fingerprint: result.fingerprint,
    reference: {
      id: record.referenceId,
      image: { uri: `sha256:${record.image.sha256}`, mimeType: record.image.mimeType },
      origin: { kind: "unknown" },
      submittedAt: record.recordedAt,
    },
  };
}

/** Reads one saved run record from disk. Only the given file is read. */
export async function loadSavedFingerprint(path: string, caseId: string): Promise<SavedFingerprint> {
  const label = `Run record ${basename(path)}`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new SavedRunError(
      missing ? "missing_record" : "unreadable_record",
      missing
        ? `${label} not found. Save a run first with analyze:image --live --case ${caseId} --output <file>.`
        : `${label} cannot be read`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SavedRunError("malformed_json", `${label} is not valid JSON`);
  }
  return savedFingerprintFromRecord(raw, caseId, label);
}

/**
 * ImageUnderstandingService that replays one already-validated fingerprint.
 * It never calls a model and refuses references it does not belong to.
 */
export class SavedFingerprintImageUnderstandingService implements ImageUnderstandingService {
  constructor(private readonly fingerprint: FurnitureFingerprint) {}

  async analyze(reference: ReferenceImage): Promise<FurnitureFingerprint> {
    if (!this.fingerprint.referenceImageIds.includes(reference.id)) {
      throw new Error(`Saved fingerprint "${this.fingerprint.id}" does not belong to reference "${reference.id}"`);
    }
    return structuredClone(this.fingerprint);
  }
}
