import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateListing } from "../domain";
import { localImageMapSchema } from "../evaluation/dataset";
import type { SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { summarizeIssues } from "../validation/issues";
import type { EmbedImageSpec } from "./protocol";
import type { RejectedImage } from "./types";

/**
 * Resolves the image evidence for a shortlist run. Only two kinds of file are
 * ever read:
 * - the reference photograph mapped to the case in the private image mapping,
 *   accepted only when its SHA-256 equals the hash in the saved run record;
 * - candidate images declared as `localPath` in a validated manifest, which
 *   must resolve (after following symlinks) inside <candidates>/<case-id>/.
 * Paths stay local: reports carry hashes and manifest references only.
 */

export const LOCAL_EVIDENCE_PREFIX = "local-evidence:";

/** Evidence that must not be used at all (wrong file, unsafe path). Aborts the run. */
export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

export interface ReferenceEvidence {
  id: string;
  /** Absolute path; passed to the embedding component, never written to reports. */
  path: string;
  sha256: string;
}

/** Finds the case's reference photograph through the private image mapping and checks its hash. */
export async function resolveReferenceImage(mapPath: string, saved: SavedFingerprint): Promise<ReferenceEvidence> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(mapPath, "utf8"));
  } catch {
    throw new EvidenceError("The local image mapping cannot be read or is not valid JSON");
  }
  const parsed = localImageMapSchema.safeParse(raw);
  if (!parsed.success) throw new EvidenceError(`The local image mapping is invalid: ${summarizeIssues(parsed.error)}`);
  const mapped = parsed.data.images[saved.caseId];
  if (!mapped) throw new EvidenceError(`The local image mapping has no reference photograph for case "${saved.caseId}"`);
  const path = isAbsolute(mapped) ? mapped : resolve(dirname(mapPath), mapped);

  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new EvidenceError(`The reference photograph for case "${saved.caseId}" was not found at its mapped location`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new EvidenceError(`The mapped reference photograph for case "${saved.caseId}" is not a regular file`);
  }
  const digest = sha256(await readFile(path));
  const expected = saved.record.image.sha256;
  if (digest !== expected) {
    throw new EvidenceError(
      `The mapped reference photograph for case "${saved.caseId}" does not match the image the saved fingerprint was made from (SHA-256 differs)`,
    );
  }
  return { id: saved.reference.id, path, sha256: digest };
}

export interface PlannedImage extends EmbedImageSpec {
  role: string | null;
}

export interface ListingImagePlan {
  listing: CandidateListing;
  /** Usable-looking local images in priority order; the embedding component picks the first that decodes. */
  images: PlannedImage[];
  /** Images skipped before embedding (remote URLs, missing files). */
  rejected: RejectedImage[];
}

/** Images with role "primary" first, then the rest; manifest order within each. */
export function prioritizeImages<T extends { role?: string | null }>(images: readonly T[]): T[] {
  return [...images.filter((i) => i.role === "primary"), ...images.filter((i) => i.role !== "primary")];
}

/**
 * Plans which local images each listing may use. Unsafe paths throw
 * EvidenceError; missing files and remote-only images are recorded as
 * rejections so the listing can fall back or be excluded explicitly.
 */
export async function planListingImages(
  listings: readonly CandidateListing[],
  manifestDir: string,
  caseId: string,
): Promise<ListingImagePlan[]> {
  const evidenceDir = join(manifestDir, caseId);
  let evidenceRoot: string | undefined;
  try {
    evidenceRoot = await realpath(evidenceDir);
  } catch {
    evidenceRoot = undefined; // no evidence folder: every local image is missing
  }
  if (evidenceRoot && evidenceRoot !== join(await realpath(manifestDir), caseId)) {
    throw new EvidenceError(`The evidence folder ${caseId}/ is a symbolic link; it must be a real folder next to the manifest`);
  }

  const plans: ListingImagePlan[] = [];
  for (const listing of listings) {
    const images: PlannedImage[] = [];
    const rejected: RejectedImage[] = [];
    for (const image of prioritizeImages(listing.images)) {
      if (!image.uri.startsWith(LOCAL_EVIDENCE_PREFIX)) {
        rejected.push({ ref: image.uri, problem: "remote_url_not_fetched", message: "remote image URLs are not downloaded" });
        continue;
      }
      const ref = image.uri.slice(LOCAL_EVIDENCE_PREFIX.length);
      const lexical = resolve(manifestDir, ref);
      if (!isInside(resolve(evidenceDir), lexical)) {
        throw new EvidenceError(`Listing ${listing.id}: image "${ref}" is not inside the evidence folder ${caseId}/`);
      }
      let info;
      try {
        info = await lstat(lexical);
      } catch {
        rejected.push({ ref, problem: "missing_file", message: "image file not found" });
        continue;
      }
      if (info.isSymbolicLink()) throw new EvidenceError(`Listing ${listing.id}: image "${ref}" is a symbolic link`);
      if (!info.isFile()) throw new EvidenceError(`Listing ${listing.id}: image "${ref}" is not a regular file`);
      const real = await realpath(lexical);
      if (!evidenceRoot || !isInside(evidenceRoot, real)) {
        throw new EvidenceError(`Listing ${listing.id}: image "${ref}" resolves outside the evidence folder ${caseId}/`);
      }
      if (info.size === 0) {
        rejected.push({ ref, problem: "empty_file", message: "image file is empty" });
        continue;
      }
      images.push({ ref, path: real, sha256: sha256(await readFile(real)), role: image.role ?? null });
    }
    plans.push({ listing, images, rejected });
  }
  return plans;
}
