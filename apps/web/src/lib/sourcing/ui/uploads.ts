import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ImageInputError, validateImageBytes } from "../image-input/image-content";
import { inspectImage } from "../image-input/inspect";
import type { Paths } from "./data";

/**
 * Private staging of new reference photographs (evals/local/uploads/<id>/).
 * The bytes are validated (signature, structure, dimensions, size) and stored
 * unchanged under a generated name; the original filename is kept for display
 * only. Nothing is sent anywhere and no analysis runs: a staged upload is
 * "awaiting image understanding" until an explicitly approved step exists.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ID = /^upl-[0-9TZ-]+-[0-9a-f]{8}$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export const uploadRecordSchema = z.strictObject({
  recordType: z.literal("reference_upload"),
  schemaVersion: z.literal(1),
  id: z.string().regex(UPLOAD_ID),
  uploadedAt: z.string(),
  status: z.literal("awaiting_image_understanding"),
  file: z.string().regex(/^image\.(png|jpg|webp)$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.int().positive(),
  height: z.int().positive(),
  bytes: z.int().positive(),
  /** Display only; never used to build a path. */
  originalName: z.string().max(120).nullable(),
});
export type UploadRecord = z.output<typeof uploadRecordSchema>;

export class UploadRejected extends Error {
  constructor(
    readonly code: "empty" | "too_large" | "unsupported_format" | "corrupt" | "dimensions",
    message: string,
  ) {
    super(message);
    this.name = "UploadRejected";
  }
}

export function sanitizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120).trim();
  return clean || null;
}

/** Validates and stores one upload; never overwrites (fresh id, exclusive writes). */
export async function stageUpload(paths: Paths, bytes: Uint8Array, originalName: string | null, now = new Date()): Promise<UploadRecord> {
  if (bytes.length === 0) throw new UploadRejected("empty", "The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRejected("too_large", `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  let mimeType: keyof typeof EXT;
  let width: number;
  let height: number;
  try {
    mimeType = validateImageBytes(bytes, MAX_UPLOAD_BYTES).mimeType;
    ({ width, height } = inspectImage(bytes));
  } catch (error) {
    if (error instanceof ImageInputError) {
      if (error.code === "too_large") throw new UploadRejected("dimensions", error.message);
      throw new UploadRejected(/Corrupted/.test(error.message) ? "corrupt" : "unsupported_format", error.message.replace(/^Corrupted image: /, "The image appears corrupted: "));
    }
    throw error;
  }
  const id = `upl-${now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const dir = join(paths.uploads, id);
  await mkdir(paths.uploads, { recursive: true });
  await mkdir(dir); // fails if the folder already exists
  const record: UploadRecord = {
    recordType: "reference_upload",
    schemaVersion: 1,
    id,
    uploadedAt: now.toISOString(),
    status: "awaiting_image_understanding",
    file: `image.${EXT[mimeType]}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType,
    width,
    height,
    bytes: bytes.length,
    originalName: sanitizeName(originalName),
  };
  await writeFile(join(dir, record.file), bytes, { flag: "wx" });
  await writeFile(join(dir, "upload.json"), `${JSON.stringify(uploadRecordSchema.parse(record), null, 2)}\n`, { flag: "wx" });
  return record;
}

export async function getUpload(paths: Paths, id: string): Promise<UploadRecord | null> {
  if (!UPLOAD_ID.test(id)) return null;
  try {
    const parsed = uploadRecordSchema.safeParse(JSON.parse(await readFile(join(paths.uploads, id, "upload.json"), "utf8")));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listUploads(paths: Paths): Promise<UploadRecord[]> {
  let names: string[];
  try {
    names = (await readdir(paths.uploads)).filter((n) => UPLOAD_ID.test(n));
  } catch {
    return [];
  }
  const records = await Promise.all(names.map((n) => getUpload(paths, n)));
  return records.filter((r): r is UploadRecord => r !== null).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

export const uploadImageUrl = (id: string) => `/api/sourcing/evidence/upload/${id}`;
