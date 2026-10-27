import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCuratedCandidates } from "../curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../curated/manifest";
import { buildProviderManifest, normalizeRunRows } from "../providers/apify/normalize";
import { product } from "../providers/apify/test-fixtures";
import { planListingImages } from "../../shortlisting/evidence";
import { makeJpeg, makePng, makeWebp } from "../../verification/openai/test-fixtures";
import { acquireListingImages } from "./acquire-images";
import { ImageFetchError, type FetchedImage } from "./safe-image-fetch";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-images-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CASE = "test-live-bed";
const ids = ["1000000000401", "1000000000402", "1000000000403", "1000000000404", "1000000000405", "1000000000406"];

function manifest() {
  const rows = ids.map((id, i) => product("live-shaped", id, { position: i + 1 }));
  // Two listings share one image URL; one has none.
  (rows[4] as Record<string, unknown>).imageUrl = (rows[0] as Record<string, unknown>).imageUrl;
  (rows[4] as Record<string, unknown>).images = [];
  (rows[5] as Record<string, unknown>).imageUrl = null;
  (rows[5] as Record<string, unknown>).images = [];
  const n = normalizeRunRows({ mode: "image", providerRunId: "RunImage000000001", capturedAt: "2026-10-27T10:01:00.000Z", items: rows }, "live");
  return buildProviderManifest({
    caseId: CASE,
    referenceImageId: "ref-test-live",
    fingerprintId: "fp-test-live",
    dataSource: "live",
    capturedAt: "2026-10-27T10:05:00.000Z",
    runs: [{ mode: "image", providerRunId: "RunImage000000001", status: "succeeded", startedAt: null, finishedAt: null, chargedUsd: null }],
    normalized: [n],
    queries: [],
    notes: "[TEST]",
  }).manifest;
}

const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(40, 1)]);
const bodies: Record<string, Uint8Array | Error> = {
  "1000000000401": makePng(40, 30, 1),
  "1000000000402": makeJpeg(40, 30),
  "1000000000403": makeWebp(50, 20),
  "1000000000404": avif,
};

function fetcher(overrides: Record<string, Uint8Array | Error> = {}) {
  return vi.fn(async (url: string): Promise<FetchedImage> => {
    const id = /kf\/(\d+)-/.exec(url)?.[1] ?? "";
    const body = { ...bodies, ...overrides }[id];
    if (!body) throw new ImageFetchError("http_error", "HTTP 404");
    if (body instanceof Error) throw body;
    return { url, contentType: "image/*", bytes: body };
  });
}

describe("acquireListingImages", () => {
  it("caches PNG, JPEG and WebP, converts AVIF, fetches a shared URL once and records missing images", async () => {
    const fetchImage = fetcher();
    const convertAvif = vi.fn(async (_src: string, _sha: string, out: string) => {
      await writeFile(out, makePng(64, 48, 9), { flag: "wx" });
    });
    const { manifest: m, outcomes } = await acquireListingImages(manifest(), { runDir: dir, caseId: CASE, imagesPerListing: 1, maxImages: 10, fetchImage, convertAvif });
    expect(fetchImage).toHaveBeenCalledTimes(4); // listing 405 reuses listing 401's URL
    expect(outcomes.map((o) => [o.status, "mimeType" in o ? o.mimeType : o.reason])).toEqual([
      ["cached", "image/png"],
      ["cached", "image/jpeg"],
      ["cached", "image/webp"],
      ["cached", "image/png"],
      ["cached", "image/png"],
    ]);
    expect(outcomes[3]).toMatchObject({ convertedFrom: "image/avif", width: 64, height: 48 });
    expect(convertAvif).toHaveBeenCalledTimes(1);
    const parsed = candidateManifestSchema.parse(m);
    expect(parsed.candidates[0].images[0]).toMatchObject({ localPath: expect.stringMatching(new RegExp(`^${CASE}/[0-9a-f]{24}\\.png$`)), role: "primary" });
    expect(parsed.candidates[0].images.slice(1).every((i) => "url" in i && i.role !== "primary")).toBe(true);
    expect(parsed.candidates[5].images).toEqual([]);
    expect(parsed.candidates[5].notes).toContain("no provider image URL");
    const files = await readdir(join(dir, CASE));
    expect(files).toHaveLength(4);

    // The shortlist's evidence resolver accepts the cached files.
    const plans = await planListingImages(importCuratedCandidates([parsed]).listings, dir, CASE);
    expect(plans.filter((p) => p.images.length > 0)).toHaveLength(5);
  });

  it("keeps listings without a local image when downloads fail, are corrupt, or AVIF cannot be converted", async () => {
    const fetchImage = fetcher({
      "1000000000401": new ImageFetchError("private_address", "Host resolves to a non-public address"),
      "1000000000402": makePng(40, 30).subarray(0, 50),
      "1000000000403": new TextEncoder().encode("<html>not an image</html>"),
    });
    const { manifest: m, outcomes } = await acquireListingImages(manifest(), { runDir: dir, caseId: CASE, imagesPerListing: 1, maxImages: 10, fetchImage, convertAvif: null });
    const reasons = outcomes.map((o) => ("reason" in o ? o.reason.split(":")[0] : o.status));
    expect(reasons).toEqual(["private_address", "unsupported_format", "unsupported_format", "unsupported_format", "private_address"]);
    expect(m.candidates.every((c) => !c.images.some((i) => "localPath" in i))).toBe(true);
    expect(m.candidates[0].notes).toMatch(/Image evidence: image 1 not cached \(private_address/);
    await expect(readdir(join(dir, CASE))).rejects.toThrow(); // empty evidence folder removed
  });

  it("respects the image limit and never overwrites a different existing file", async () => {
    const limited = await acquireListingImages(manifest(), { runDir: dir, caseId: CASE, imagesPerListing: 1, maxImages: 2, fetchImage: fetcher(), convertAvif: null });
    expect(limited.outcomes.filter((o) => o.status === "skipped_limit")).toHaveLength(2);

    const again = await acquireListingImages(manifest(), { runDir: dir, caseId: CASE, imagesPerListing: 1, maxImages: 2, fetchImage: fetcher(), convertAvif: null });
    expect(again.outcomes[0].status).toBe("reused");

    const first = limited.outcomes[0] as { localPath: string };
    await writeFile(join(dir, first.localPath), "tampered");
    const clash = await acquireListingImages(manifest(), { runDir: dir, caseId: CASE, imagesPerListing: 1, maxImages: 1, fetchImage: fetcher(), convertAvif: null });
    expect(clash.outcomes[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("refusing to overwrite") });
    expect(await readFile(join(dir, first.localPath), "utf8")).toBe("tampered");
  });
});
