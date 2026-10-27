import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectImageMimeType } from "../image-input/image-content";
import { EvidenceError, resolveReferenceImage } from "../shortlisting/evidence";
import { loadSavedFingerprint, SavedRunError } from "../understanding/saved/saved-fingerprint";
import { CASE_ID, getRun, LISTING_ID, RUN_ID, runManifestDir, type Paths } from "./data";
import { getUpload, UPLOAD_ID } from "./uploads";

/**
 * Resolves an evidence id to image bytes for the browser. Ids name records,
 * never files:
 *   reference/<case>                 → the case's reference photo (mapping + saved hash)
 *   candidate/<case>/<run>/<listing> → the image the run recorded for that listing
 *   upload/<upload id>               → a staged upload
 * The file path always comes from trusted records, must stay inside its
 * approved folder (no symlinks, no escapes), must be a PNG/JPEG/WebP within the
 * size limit, and must still have the SHA-256 recorded for it. Errors never
 * include local paths.
 */

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

export type EvidenceResult =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; status: 400 | 404 | 409 | 415 | 413; code: string; message: string };

const fail = (status: 400 | 404 | 409 | 415 | 413, code: string, message: string): EvidenceResult => ({ ok: false, status, code, message });
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** Reads a file confined to `root`, refusing symlinks and escapes, and checks size, format and hash. */
export async function readConfined(root: string, relPath: string, expectedSha: string): Promise<EvidenceResult> {
  if (relPath.split(/[\\/]/).includes("..") || isAbsolute(relPath)) return fail(400, "invalid_path", "Evidence path is not allowed");
  const lexical = resolve(root, relPath);
  if (!inside(resolve(root), lexical)) return fail(400, "invalid_path", "Evidence path is not allowed");
  let info;
  try {
    info = await lstat(lexical);
  } catch {
    return fail(404, "missing_image", "The image file is missing");
  }
  if (info.isSymbolicLink() || !info.isFile()) return fail(400, "invalid_path", "Evidence must be a regular file");
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return fail(404, "missing_image", "The evidence folder is missing");
  }
  if (!inside(realRoot, await realpath(lexical))) return fail(400, "invalid_path", "Evidence resolves outside its folder");
  if (info.size > MAX_EVIDENCE_BYTES) return fail(413, "too_large", "The image is too large to display");
  const bytes = new Uint8Array(await readFile(lexical));
  if (sha256(bytes) !== expectedSha) return fail(409, "changed", "The image changed after it was recorded");
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) return fail(415, "unsupported_format", "Only PNG, JPEG and WebP evidence is served");
  return { ok: true, bytes, mimeType };
}

export async function resolveEvidence(paths: Paths, parts: string[]): Promise<EvidenceResult> {
  const [kind, ...rest] = parts;
  if (kind === "reference" && rest.length === 1 && CASE_ID.test(rest[0])) {
    const caseId = rest[0];
    let saved;
    try {
      saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
    } catch (error) {
      if (error instanceof SavedRunError) return fail(404, "unknown_reference", "No saved reference for this case");
      throw error;
    }
    try {
      const ref = await resolveReferenceImage(paths.imagesMap, saved);
      const bytes = new Uint8Array(await readFile(ref.path));
      if (bytes.length > MAX_EVIDENCE_BYTES) return fail(413, "too_large", "The image is too large to display");
      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) return fail(415, "unsupported_format", "Only PNG, JPEG and WebP evidence is served");
      return { ok: true, bytes, mimeType };
    } catch (error) {
      if (error instanceof EvidenceError) return fail(/does not match/.test(error.message) ? 409 : 404, "reference_unavailable", "The reference photo is unavailable or differs from the analysed image");
      throw error;
    }
  }
  if (kind === "candidate" && rest.length === 3 && CASE_ID.test(rest[0]) && RUN_ID.test(rest[1]) && LISTING_ID.test(rest[2])) {
    const [caseId, runId, listingId] = rest;
    const run = await getRun(paths, caseId, runId);
    const entry = run?.result ? [...run.result.verified, ...run.result.abstained, ...run.result.unverified].find((e) => e.listingId === listingId) : undefined;
    const image = entry?.imageEvidence.image;
    if (!image) return fail(404, "no_image", "No local image was recorded for this candidate");
    const manifestDir = await runManifestDir(paths, caseId, runId);
    if (!manifestDir) return fail(404, "no_image", "The run's candidate source is unavailable");
    // Approved evidence roots: private candidate and discovery folders, and committed synthetic discovery fixtures.
    const approved = [paths.candidates, join(paths.root, "evals/local/discovery"), join(paths.root, "evals/discovery")];
    if (!approved.some((root) => resolve(manifestDir) === resolve(root) || inside(resolve(root), resolve(manifestDir)))) {
      return fail(400, "invalid_path", "The run's candidate source is outside the approved evidence folders");
    }
    if (!image.ref.startsWith(`${caseId}/`)) return fail(400, "invalid_path", "Evidence path is not allowed");
    return readConfined(join(manifestDir, caseId), image.ref.slice(caseId.length + 1), image.sha256);
  }
  if (kind === "upload" && rest.length === 1 && UPLOAD_ID.test(rest[0])) {
    const upload = await getUpload(paths, rest[0]);
    if (!upload) return fail(404, "unknown_upload", "No such upload");
    return readConfined(join(paths.uploads, upload.id), upload.file, upload.sha256);
  }
  return fail(400, "invalid_evidence_id", "Unknown evidence id");
}

export function evidenceResponse(result: EvidenceResult): Response {
  const common = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (!result.ok) return Response.json({ error: result.code, message: result.message }, { status: result.status, headers: common });
  return new Response(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mimeType }), {
    status: 200,
    headers: { ...common, "Content-Type": result.mimeType, "Content-Length": String(result.bytes.length) },
  });
}
