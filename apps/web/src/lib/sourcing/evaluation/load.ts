import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { z } from "zod";
import { summarizeIssues } from "../validation/issues";
import { evaluationDatasetSchema, localImageMapSchema, type EvaluationDataset } from "./dataset";
import type { ImageCheck, Loaded, LoadIssue } from "./engine";

export class EvaluationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationInputError";
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

/** Reads and validates the dataset; throws EvaluationInputError on any problem. */
export async function loadDataset(path: string): Promise<EvaluationDataset> {
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
    throw new EvaluationInputError(`Dataset ${basename(path)} ${reason}`);
  }
  const parsed = evaluationDatasetSchema.safeParse(raw);
  if (!parsed.success) throw new EvaluationInputError(`Dataset ${basename(path)} is invalid: ${summarizeIssues(parsed.error)}`);
  return parsed.data;
}

/**
 * Loads every *.json file in a directory with a schema. Malformed or invalid
 * files are reported as issues, never silently dropped. A missing directory
 * yields no records.
 */
export async function loadRecordDirectory<S extends z.ZodType>(
  dir: string,
  schema: S,
): Promise<{ records: Loaded<z.output<S>>[]; issues: LoadIssue[]; directoryFound: boolean }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return { records: [], issues: [], directoryFound: false };
  }
  const records: Loaded<z.output<S>>[] = [];
  const issues: LoadIssue[] = [];
  for (const file of names) {
    let raw: unknown;
    try {
      raw = await readJson(join(dir, file));
    } catch (error) {
      issues.push({
        file,
        problem: error instanceof SyntaxError ? "malformed_json" : "unreadable",
        detail: error instanceof SyntaxError ? "Not valid JSON" : "Cannot be read",
      });
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      issues.push({ file, problem: "invalid_record", detail: summarizeIssues(parsed.error) });
      continue;
    }
    records.push({ file, record: parsed.data });
  }
  return { records, issues, directoryFound: true };
}

/**
 * Checks a private case-id → image-path mapping against the dataset's
 * expected image hashes. Paths are resolved relative to the mapping file and
 * never copied into reports.
 */
export async function checkLocalImages(mapPath: string, dataset: EvaluationDataset): Promise<ImageCheck[]> {
  let raw: unknown;
  try {
    raw = await readJson(mapPath);
  } catch {
    throw new EvaluationInputError(`Image mapping ${basename(mapPath)} cannot be read or is not valid JSON`);
  }
  const parsed = localImageMapSchema.safeParse(raw);
  if (!parsed.success) throw new EvaluationInputError(`Image mapping is invalid: ${summarizeIssues(parsed.error)}`);

  const checks: ImageCheck[] = [];
  for (const c of dataset.cases) {
    const mapped = parsed.data.images[c.id];
    if (!mapped) continue;
    const path = isAbsolute(mapped) ? mapped : resolve(dirname(mapPath), mapped);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      checks.push({ caseId: c.id, status: "missing_file" });
      continue;
    }
    if (!c.imageSha256) {
      checks.push({ caseId: c.id, status: "no_expected_hash" });
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    checks.push({ caseId: c.id, status: digest === c.imageSha256 ? "matches" : "mismatch" });
  }
  return checks;
}
