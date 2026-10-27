import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectImageMimeType, ImageInputError } from "../../image-input/image-content";
import { inspectImage } from "../../image-input/inspect";
import type { CandidateManifest } from "../curated/manifest";
import { ImageFetchError, type FetchedImage } from "./safe-image-fetch";

/**
 * Caches provider-returned listing images as local evidence next to a
 * provider_api manifest (<run dir>/<case>/<sha>.<ext>), so the existing
 * shortlist and verification commands can use them. Only URLs already in the
 * manifest are fetched, at most `imagesPerListing` per listing (primary first)
 * and `maxImages` in total. AVIF is decoded and re-encoded as PNG by the local
 * vision component; the AVIF original is not referenced. Failures leave the
 * listing without local evidence and are reported; nothing is substituted.
 */

export interface ImageAcquisitionOptions {
  runDir: string;
  caseId: string;
  imagesPerListing: number;
  maxImages: number;
  fetchImage: (url: string) => Promise<FetchedImage>;
  /** AVIF → PNG conversion; null when the local vision component is unavailable. */
  convertAvif: ((avifPath: string, sha256: string, pngPath: string) => Promise<void>) | null;
}

export type ImageOutcome =
  | { listingUrl: string; url: string; status: "cached" | "reused"; localPath: string; sha256: string; mimeType: string; width: number; height: number; convertedFrom: "image/avif" | null }
  | { listingUrl: string; url: string; status: "failed" | "skipped_limit"; reason: string };

const isAvif = (b: Uint8Array) => b.length > 12 && Buffer.from(b.subarray(4, 12)).toString("latin1").match(/^ftypavi[fs]$/) !== null;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function existingSha(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Stores bytes under their hash; an existing file with the same content is reused, never overwritten. */
async function store(dir: string, name: string, bytes: Uint8Array): Promise<"cached" | "reused"> {
  const path = join(dir, name);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const present = await existingSha(path);
  if (present === sha) return "reused";
  if (present !== null) throw new Error(`refusing to overwrite ${name}`);
  await writeFile(path, bytes, { flag: "wx" });
  return "cached";
}

export async function acquireListingImages(
  manifest: CandidateManifest,
  options: ImageAcquisitionOptions,
): Promise<{ manifest: CandidateManifest; outcomes: ImageOutcome[] }> {
  const evidenceDir = join(options.runDir, options.caseId);
  await mkdir(evidenceDir, { recursive: true });
  const byUrl = new Map<string, ImageOutcome>();
  const outcomes: ImageOutcome[] = [];
  let fetched = 0;

  const fetchOne = async (listingUrl: string, url: string): Promise<ImageOutcome> => {
    const known = byUrl.get(url);
    if (known) return { ...known, listingUrl };
    if (fetched >= options.maxImages) return { listingUrl, url, status: "skipped_limit", reason: `image limit of ${options.maxImages} reached` };
    fetched++;
    let result: ImageOutcome;
    try {
      const image = await options.fetchImage(url);
      const sha256 = createHash("sha256").update(image.bytes).digest("hex");
      const stem = sha256.slice(0, 24);
      if (isAvif(image.bytes)) {
        if (!options.convertAvif) throw new ImageInputError("unsupported_format", "AVIF image and the local AVIF converter (services/vision) is unavailable");
        const originals = join(options.runDir, "avif-originals");
        await mkdir(originals, { recursive: true });
        await store(originals, `${stem}.avif`, image.bytes);
        const pngName = `${stem}.png`;
        const pngPath = join(evidenceDir, pngName);
        let status: "cached" | "reused" = "reused";
        if ((await existingSha(pngPath)) === null) {
          await options.convertAvif(join(originals, `${stem}.avif`), sha256, pngPath);
          status = "cached";
        }
        const png = new Uint8Array(await readFile(pngPath));
        const info = inspectImage(png);
        result = { listingUrl, url, status, localPath: `${options.caseId}/${pngName}`, sha256: createHash("sha256").update(png).digest("hex"), mimeType: "image/png", width: info.width, height: info.height, convertedFrom: "image/avif" };
      } else {
        const sniffed = detectImageMimeType(image.bytes);
        if (!sniffed) throw new ImageInputError("unsupported_format", `content is not JPEG, PNG, WebP or AVIF (declared ${image.contentType})`);
        const info = inspectImage(image.bytes); // structure, dimensions and pixel limits
        const name = `${stem}.${EXT[sniffed]}`;
        const status = await store(evidenceDir, name, image.bytes);
        result = { listingUrl, url, status, localPath: `${options.caseId}/${name}`, sha256, mimeType: sniffed, width: info.width, height: info.height, convertedFrom: null };
      }
    } catch (error) {
      const reason =
        error instanceof ImageFetchError || error instanceof ImageInputError
          ? `${error instanceof ImageFetchError ? error.code : error.code}: ${error.message}`
          : `error: ${(error as Error).message}`;
      result = { listingUrl, url, status: "failed", reason };
    }
    byUrl.set(url, result);
    return result;
  };

  const candidates = [];
  for (const c of manifest.candidates) {
    const remote = c.images.filter((i): i is Extract<typeof i, { url: string }> => "url" in i);
    const ordered = [...remote.filter((i) => i.role === "primary"), ...remote.filter((i) => i.role !== "primary")].slice(0, options.imagesPerListing);
    const local: CandidateManifest["candidates"][number]["images"] = [];
    const notes: string[] = [];
    for (const [i, img] of ordered.entries()) {
      const outcome = await fetchOne(c.listingUrl, img.url);
      outcomes.push(outcome);
      if (outcome.status === "cached" || outcome.status === "reused") {
        if (!local.some((l) => "localPath" in l && l.localPath === outcome.localPath)) {
          local.push({ localPath: outcome.localPath, role: i === 0 ? "primary" : "gallery", mimeType: outcome.mimeType as "image/jpeg" | "image/png" | "image/webp" });
        }
      } else {
        notes.push(`image ${i + 1} not cached (${"reason" in outcome ? outcome.reason : outcome.status})`);
      }
    }
    if (remote.length === 0) notes.push("no provider image URL");
    // Local copies first (used by the shortlist), remote URLs kept as provenance without a "primary" role.
    const keptRemote = c.images.filter((i) => !("localPath" in i)).map((i) => (local.length ? { ...i, role: i.role === "primary" ? "source" : i.role } : i));
    const others = c.images.filter((i) => "localPath" in i);
    const note = notes.length ? `Image evidence: ${notes.join("; ")}.` : null;
    candidates.push({
      ...c,
      images: [...local, ...others, ...keptRemote],
      notes: [c.notes, note].filter(Boolean).join(" ") || c.notes,
    });
  }
  // Remove the evidence folder only if it is empty (rmdir never deletes files).
  await rmdir(evidenceDir).catch(() => {});
  return { manifest: { ...manifest, candidates }, outcomes };
}
