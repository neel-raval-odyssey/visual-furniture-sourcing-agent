import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { localImageMapSchema, type LocalImageMap } from "../../evaluation/dataset";
import type { RunRecord } from "../../evaluation/run-record";
import { resolveReferenceImage } from "../../shortlisting/evidence";
import { loadSavedFingerprint, savedFingerprintFromRecord } from "../../understanding/saved/saved-fingerprint";
import { summarizeIssues } from "../../validation/issues";
import type { Paths } from "../data";
import { writeExclusive, writeReplace } from "./attempts";

/**
 * Makes an analysed upload a reference the existing sourcing code reads:
 * the standard run record at evals/local/predictions/<case>.json and an entry
 * in the private image mapping that points at the staged photo (relative to
 * the mapping, so the photo is not copied). The fingerprint is written before
 * the mapping, existing files and entries are never replaced, and the mapping
 * is updated under a cross-process lock with an atomic rename.
 */

export class RegistrationError extends Error {
  constructor(
    readonly code: "case_collision" | "image_map_conflict" | "image_map_invalid" | "image_map_busy" | "verification_failed",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lock older than this is assumed abandoned by a crashed process. */
export const IMAGE_MAP_LOCK_STALE_MS = 30_000;

/** Runs `fn` while holding <images.json>.lock (exclusive create; waits up to `timeoutMs`). */
export async function withImageMapLock<T>(mapPath: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const lock = `${mapPath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(lock, `${token}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > IMAGE_MAP_LOCK_STALE_MS) await unlink(lock).catch(() => {});
      } catch {
        // The lock disappeared between the attempts; try again.
      }
      if (Date.now() > deadline) throw new RegistrationError("image_map_busy", "The image mapping is locked by another update");
      await wait(25 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => "")).trim() === token) await unlink(lock).catch(() => {});
  }
}

/** Adds one case → image entry, preserving every existing entry. Re-adding the same entry is a no-op. */
export async function addImageMapEntry(mapPath: string, caseId: string, imagePath: string): Promise<void> {
  await withImageMapLock(mapPath, async () => {
    let map: LocalImageMap;
    let text: string | null = null;
    try {
      text = await readFile(mapPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text === null) {
      map = { schemaVersion: 1, images: {} };
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new RegistrationError("image_map_invalid", "The image mapping is not valid JSON; it was left unchanged");
      }
      const parsed = localImageMapSchema.safeParse(raw);
      if (!parsed.success) throw new RegistrationError("image_map_invalid", `The image mapping is invalid (${summarizeIssues(parsed.error)}); it was left unchanged`);
      map = parsed.data;
    }
    const existing = map.images[caseId];
    if (existing === imagePath) return;
    if (existing !== undefined) throw new RegistrationError("image_map_conflict", `The image mapping already has a different photo for "${caseId}"`);
    await writeReplace(mapPath, json({ ...map, images: { ...map.images, [caseId]: imagePath } }));
  });
}

export interface Registration {
  /** Repository-relative path of the saved prediction. */
  predictionFile: string;
  /** The mapping entry (relative to the mapping file). */
  imageMapEntry: string;
}

/**
 * Registers a validated "furniture_identified" run record for `caseId`.
 * Idempotent: an identical prediction or mapping entry already in place is
 * accepted; anything different is a collision and nothing is overwritten.
 */
export async function registerReference(paths: Paths, record: RunRecord, caseId: string, imageFile: string): Promise<Registration> {
  savedFingerprintFromRecord(record, caseId, "New run record"); // same checks the loader applies
  const predictionPath = join(paths.predictions, `${caseId}.json`);
  const text = json(record);
  await mkdir(paths.predictions, { recursive: true });
  if (!(await writeExclusive(predictionPath, text))) {
    if ((await readFile(predictionPath, "utf8")) !== text) {
      throw new RegistrationError("case_collision", `A different saved analysis already exists for "${caseId}"; it was not overwritten`);
    }
  }
  const entry = relative(dirname(paths.imagesMap), imageFile).split("\\").join("/");
  await addImageMapEntry(paths.imagesMap, caseId, entry);

  // Prove the result is readable exactly as every other reference is.
  try {
    const saved = await loadSavedFingerprint(predictionPath, caseId);
    await resolveReferenceImage(paths.imagesMap, saved);
  } catch (error) {
    throw new RegistrationError("verification_failed", `The saved reference could not be read back: ${error instanceof Error ? error.message : "unknown problem"}`);
  }
  return { predictionFile: relative(paths.root, predictionPath).split("\\").join("/"), imageMapEntry: entry };
}

/** True when `caseId` is already used by a saved prediction or a mapping entry. */
export async function caseIdInUse(paths: Paths, caseId: string): Promise<boolean> {
  try {
    await stat(join(paths.predictions, `${caseId}.json`));
    return true;
  } catch {
    // not present
  }
  try {
    const parsed = localImageMapSchema.safeParse(JSON.parse(await readFile(paths.imagesMap, "utf8")));
    return parsed.success && caseId in parsed.data.images;
  } catch {
    return false;
  }
}
