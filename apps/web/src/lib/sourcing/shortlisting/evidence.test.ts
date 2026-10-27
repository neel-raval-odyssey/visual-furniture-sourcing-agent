import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importCuratedCandidates } from "../discovery/curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../discovery/curated/manifest";
import { loadSavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { EvidenceError, planListingImages, prioritizeImages, resolveReferenceImage } from "./evidence";
import { REFERENCE_BYTES, sha256, TEST_CASE, testManifest, writeTestCase } from "./test-fixtures";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-evidence-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const listingsOf = (manifest = testManifest()) => importCuratedCandidates([candidateManifestSchema.parse(manifest)]).listings;

describe("reference evidence", () => {
  it("accepts the mapped photograph only when it matches the saved run's image hash", async () => {
    const paths = await writeTestCase(dir);
    const saved = await loadSavedFingerprint(paths.record, TEST_CASE);
    const ref = await resolveReferenceImage(paths.images, saved);
    expect(ref).toEqual({ id: "ref-test-live", path: join(dir, "photos/reference.png"), sha256: sha256(REFERENCE_BYTES) });

    await writeFile(join(dir, "photos/reference.png"), "a different photograph");
    await expect(resolveReferenceImage(paths.images, saved)).rejects.toThrow(/does not match the image the saved fingerprint was made from/);
  });

  it("reports unmapped cases, missing photographs and symlinks", async () => {
    const paths = await writeTestCase(dir);
    const saved = await loadSavedFingerprint(paths.record, TEST_CASE);
    await writeFile(paths.images, JSON.stringify({ schemaVersion: 1, images: { other: "photos/reference.png" } }));
    await expect(resolveReferenceImage(paths.images, saved)).rejects.toThrow(/no reference photograph for case/);
    await writeFile(paths.images, JSON.stringify({ schemaVersion: 1, images: { [TEST_CASE]: "photos/none.png" } }));
    await expect(resolveReferenceImage(paths.images, saved)).rejects.toThrow(/not found/);
    await symlink(join(dir, "photos/reference.png"), join(dir, "photos/link.png"));
    await writeFile(paths.images, JSON.stringify({ schemaVersion: 1, images: { [TEST_CASE]: "photos/link.png" } }));
    await expect(resolveReferenceImage(paths.images, saved)).rejects.toThrow(EvidenceError);
  });
});

describe("candidate image plan", () => {
  it("orders primary images first and records remote-only and image-less listings", async () => {
    await writeTestCase(dir);
    const plans = await planListingImages(listingsOf(), join(dir, "candidates"), TEST_CASE);
    expect(plans.map((p) => p.images.map((i) => i.ref))).toEqual([
      [`${TEST_CASE}/a.png`],
      [`${TEST_CASE}/b-primary.png`, `${TEST_CASE}/b-gallery.png`],
      [],
      [],
    ]);
    expect(plans[1].rejected).toEqual([
      { ref: "https://s.alicdn.com/test/0000000002.jpg", problem: "remote_url_not_fetched", message: "remote image URLs are not downloaded" },
    ]);
    expect(plans[2].rejected[0].problem).toBe("remote_url_not_fetched");
    expect(plans[3].rejected).toEqual([]);
    expect(plans[0].images[0]).toMatchObject({ role: "primary", sha256: sha256(`[TEST] a.png`) });
  });

  it("records missing and empty files so the listing can fall back", async () => {
    await writeTestCase(dir, testManifest(), ["b-gallery.png"]);
    await writeFile(join(dir, "candidates", TEST_CASE, "b-primary.png"), "");
    const plans = await planListingImages(listingsOf(), join(dir, "candidates"), TEST_CASE);
    expect(plans[0].images).toEqual([]);
    expect(plans[0].rejected).toEqual([{ ref: `${TEST_CASE}/a.png`, problem: "missing_file", message: "image file not found" }]);
    expect(plans[1].images.map((i) => i.ref)).toEqual([`${TEST_CASE}/b-gallery.png`]);
    expect(plans[1].rejected.map((r) => r.problem)).toEqual(["empty_file", "remote_url_not_fetched"]);
  });

  it("refuses images outside the case evidence folder and symlinks that escape it", async () => {
    const m = testManifest();
    m.candidates[0] = { ...m.candidates[0], images: [{ localPath: "other-case/a.png" }] };
    await writeTestCase(dir, m);
    await expect(planListingImages(listingsOf(m), join(dir, "candidates"), TEST_CASE)).rejects.toThrow(/not inside the evidence folder/);

    const escape = testManifest();
    await writeTestCase(dir, escape, ["b-gallery.png", "b-primary.png"]);
    await rm(join(dir, "candidates", TEST_CASE, "a.png"));
    await writeFile(join(dir, "secret.png"), "outside");
    await symlink(join(dir, "secret.png"), join(dir, "candidates", TEST_CASE, "a.png"));
    await expect(planListingImages(listingsOf(escape), join(dir, "candidates"), TEST_CASE)).rejects.toThrow(/symbolic link/);

    // A symlinked evidence folder pointing elsewhere is also refused.
    await rm(join(dir, "candidates", TEST_CASE), { recursive: true });
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await writeFile(join(dir, "elsewhere", "a.png"), "x");
    await symlink(join(dir, "elsewhere"), join(dir, "candidates", TEST_CASE));
    await expect(planListingImages(listingsOf(escape), join(dir, "candidates"), TEST_CASE)).rejects.toThrow(/evidence folder .* is a symbolic link/);
  });

  it("prioritizes deterministically", () => {
    const images = [{ role: "gallery", n: 1 }, { role: "primary", n: 2 }, { role: null, n: 3 }, { role: "primary", n: 4 }];
    expect(prioritizeImages(images).map((i) => i.n)).toEqual([2, 4, 1, 3]);
  });
});
