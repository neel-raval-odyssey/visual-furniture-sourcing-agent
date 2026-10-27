import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateManifest } from "../discovery/curated/manifest";
import { liveShapedManifest, liveShapedRunRecord } from "../discovery/curated/test-fixtures";
import { PROTOCOL, PROTOCOL_VERSION, type EmbedOkResponse, type EmbedRequest } from "./protocol";

/**
 * TEST-ONLY shortlist inputs: a live-shaped run record whose image hash
 * matches placeholder bytes, a mapping to those bytes, and [TEST] listings
 * with placeholder local images. No real product, supplier or photograph.
 */

export const TEST_CASE = "test-live-bed";
export const REFERENCE_BYTES = Buffer.from("[TEST] reference image bytes");
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export function testManifest(): CandidateManifest {
  const base = liveShapedManifest();
  return {
    ...base,
    suppliers: [
      { ref: "supplier-a", name: "[TEST] Supplier A", profileUrl: "https://testsupplier-a.en.alibaba.com/" },
      { ref: "supplier-b", name: "[TEST] Supplier B" },
    ],
    candidates: [
      {
        listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed-A_0000000001.html",
        title: "[TEST] Bed A",
        images: [{ localPath: `${TEST_CASE}/a.png`, role: "primary" }],
        supplierRef: "supplier-a",
      },
      {
        listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed-B_0000000002.html",
        title: "[TEST] Bed B",
        images: [
          { url: "https://s.alicdn.com/test/0000000002.jpg" },
          { localPath: `${TEST_CASE}/b-gallery.png`, role: "gallery" },
          { localPath: `${TEST_CASE}/b-primary.png`, role: "primary" },
        ],
        supplierRef: "supplier-b",
      },
      {
        listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed-C_0000000003.html",
        title: "[TEST] Bed C (remote image only)",
        images: [{ url: "https://s.alicdn.com/test/0000000003.jpg" }],
      },
      {
        listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed-D_0000000004.html",
        title: "[TEST] Bed D (no images)",
        images: [],
      },
    ],
  };
}

/** Writes a complete test case into `dir` and returns its paths. */
export async function writeTestCase(
  dir: string,
  manifest: CandidateManifest = testManifest(),
  files = ["a.png", "b-gallery.png", "b-primary.png"],
  /** Real image bytes for tests that decode images; placeholder text otherwise. */
  bytes: { reference?: Buffer; file?: (name: string) => Buffer } = {},
) {
  const referenceBytes = bytes.reference ?? REFERENCE_BYTES;
  const record = liveShapedRunRecord() as { image: { sha256: string } };
  record.image.sha256 = sha256(referenceBytes);
  await mkdir(join(dir, "predictions"), { recursive: true });
  await mkdir(join(dir, "photos"), { recursive: true });
  await mkdir(join(dir, "candidates", TEST_CASE), { recursive: true });
  await writeFile(join(dir, "predictions", `${TEST_CASE}.json`), JSON.stringify(record));
  await writeFile(join(dir, "photos", "reference.png"), referenceBytes);
  await writeFile(join(dir, "images.json"), JSON.stringify({ schemaVersion: 1, images: { [TEST_CASE]: "photos/reference.png" } }));
  await writeFile(join(dir, "candidates", `${TEST_CASE}.json`), JSON.stringify(manifest));
  for (const f of files) await writeFile(join(dir, "candidates", TEST_CASE, f), bytes.file?.(f) ?? `[TEST] ${f}`);
  return {
    record: join(dir, "predictions", `${TEST_CASE}.json`),
    images: join(dir, "images.json"),
    manifest: join(dir, "candidates", `${TEST_CASE}.json`),
    candidatesDir: join(dir, "candidates"),
  };
}

/** A well-formed response for `request`, scoring groups as given (missing ids are reported unusable). */
export function fakeResponse(request: EmbedRequest, scores: Record<string, number>): EmbedOkResponse {
  const embedded = request.groups
    .filter((g) => g.id in scores)
    .map((g) => ({
      id: g.id,
      status: "embedded" as const,
      selectedImage: { ref: g.images[0].ref, sha256: g.images[0].sha256, format: "PNG" as const, width: 10, height: 10, sourceMode: "RGB" },
      embeddingCosineSimilarity: scores[g.id],
      rejectedImages: [],
    }))
    .sort((a, b) => b.embeddingCosineSimilarity - a.embeddingCosineSimilarity || (a.id < b.id ? -1 : 1));
  const unusable = request.groups
    .filter((g) => !(g.id in scores))
    .map((g) => ({
      id: g.id,
      status: "no_usable_image" as const,
      rejectedImages: g.images.map((i) => ({ ref: i.ref, problem: "decode_failed", message: "image file is corrupted or cannot be decoded" })),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    status: "ok",
    model: {
      id: request.model.id,
      revision: COMMIT,
      architecture: "SiglipModel",
      modelType: "siglip",
      embeddingDim: 768,
      featureSource: "get_image_features (pooled image embedding), L2-normalized",
      dtype: "float32",
    },
    device: { type: "cpu", requested: request.device, reason: "test" },
    preprocessing: { imageProcessor: "Test" },
    runtime: { python: "test" },
    reference: { id: request.reference.id, sha256: request.reference.sha256, format: "PNG", width: 10, height: 12, sourceMode: "RGB" },
    groups: [...embedded, ...unusable],
  };
}
