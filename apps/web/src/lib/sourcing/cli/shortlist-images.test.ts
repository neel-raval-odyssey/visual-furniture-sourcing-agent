import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { EmbeddingServiceError, type EmbedRequest } from "../shortlisting/protocol";
import { fakeResponse, TEST_CASE, testManifest, writeTestCase } from "../shortlisting/test-fixtures";
import type { VisualShortlist } from "../shortlisting/types";
import {
  SHORTLIST_EXIT_EMBEDDING,
  SHORTLIST_EXIT_INVALID,
  SHORTLIST_EXIT_OK,
  SHORTLIST_EXIT_USAGE,
  runShortlistImagesCli,
} from "./shortlist-images";

vi.mock("openai", () => {
  throw new Error("shortlist:images must not load the OpenAI SDK");
});

const LISTING_A = "alibaba-product-0000000001";
const LISTING_B = "alibaba-product-0000000002";
const LISTING_C = "alibaba-product-0000000003";
const LISTING_D = "alibaba-product-0000000004";

let dir: string;
const fetchSpy = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-shortlist-"));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function fakeRunner(scores: Record<string, number>) {
  const requests: EmbedRequest[] = [];
  const runner: ImageSimilarityRunner & { requests: EmbedRequest[]; environmentCalls: number } = {
    requests,
    environmentCalls: 0,
    async embed(request) {
      requests.push(structuredClone(request));
      return fakeResponse(request, scores);
    },
    async environment(model) {
      runner.environmentCalls++;
      return {
        status: "ok",
        runtime: { python: "3.13", torch: "test", transformers: "test" },
        imageFormats: { avif: true },
        device: { auto: "cpu", reason: "test" },
        model: { id: model.id, cached: false, revision: null, reason: "not cached (test)" },
      };
    },
  };
  return runner;
}

function cli(runner: ImageSimilarityRunner) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join("\n"),
    run: (...argv: string[]) =>
      runShortlistImagesCli(argv, {
        cwd: dir,
        repoRoot: dir,
        runner,
        now: () => new Date("2026-10-26T12:00:00.000Z"),
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      }),
  };
}

const args = ["--case", TEST_CASE, "--predictions", "predictions", "--candidates", "candidates", "--images", "images.json"];

describe("shortlist:images", () => {
  it("rejects bad usage", async () => {
    const r = fakeRunner({});
    expect(await cli(r).run("--help")).toBe(SHORTLIST_EXIT_OK);
    expect(await cli(r).run("--dry-run")).toBe(SHORTLIST_EXIT_USAGE);
    expect(await cli(r).run(...args, "--top-k", "0")).toBe(SHORTLIST_EXIT_USAGE);
    expect(await cli(r).run(...args, "--model", "openai/clip-vit-base-patch32")).toBe(SHORTLIST_EXIT_USAGE);
    expect(await cli(r).run(...args, "--device", "cuda")).toBe(SHORTLIST_EXIT_USAGE);
  });

  it("dry run validates inputs and reports the plan without running the model", async () => {
    await writeTestCase(dir);
    const r = fakeRunner({});
    const c = cli(r);
    expect(await c.run(...args, "--dry-run")).toBe(SHORTLIST_EXIT_OK);
    const text = c.text();
    expect(text).toContain("no model was loaded and nothing was downloaded");
    expect(text).toContain("SHA-256 matches the saved run");
    expect(text).toContain(`${TEST_CASE}/b-primary.png (role primary`);
    expect(text).toContain("1 fallback image(s)");
    expect(text).toContain("NONE USABLE — will be excluded (https://s.alicdn.com/test/0000000003.jpg: remote_url_not_fetched)");
    expect(text).toContain("Would embed 1 reference and 2 candidate image(s)");
    expect(text).toContain("Model cache: NOT READY");
    expect(r.requests).toEqual([]);
    expect(r.environmentCalls).toBe(1);
    expect(await readdir(dir)).not.toContain("evals");
  });

  it("ranks by cosine, keeps listing and supplier identity, applies top-K and saves the report", async () => {
    await writeTestCase(dir);
    const r = fakeRunner({ [LISTING_A]: 0.61, [LISTING_B]: 0.83 });
    const c = cli(r);
    expect(await c.run(...args, "--top-k", "1", "--json")).toBe(SHORTLIST_EXIT_OK);
    const s = JSON.parse(c.text()) as VisualShortlist;

    expect(r.requests).toHaveLength(1);
    expect(r.requests[0].groups.map((g) => [g.id, g.images.map((i) => i.ref)])).toEqual([
      [LISTING_A, [`${TEST_CASE}/a.png`]],
      [LISTING_B, [`${TEST_CASE}/b-primary.png`, `${TEST_CASE}/b-gallery.png`]],
    ]);
    expect(s.synthetic).toBe(false);
    expect(s.counts).toEqual({ listings: 4, embedded: 2, shortlisted: 1, belowTopK: 1, excluded: 2 });
    expect(s.shortlist).toHaveLength(1);
    expect(s.shortlist[0]).toMatchObject({
      rank: 1,
      listingId: LISTING_B,
      marketplaceProductId: "0000000002",
      title: "[TEST] Bed B",
      listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed-B_0000000002.html",
      supplier: { name: "[TEST] Supplier B" },
      image: { ref: `${TEST_CASE}/b-primary.png`, role: "primary", fallback: false },
      embeddingCosineSimilarity: 0.83,
      visualVerificationStatus: "not_assessed",
    });
    expect(s.shortlist[0].rejectedImages.map((x) => x.problem)).toEqual(["remote_url_not_fetched"]);
    expect(s.belowTopK).toEqual([LISTING_A]);
    expect(s.excluded.map((x) => [x.listingId, x.reason])).toEqual([
      [LISTING_C, "no_usable_image"],
      [LISTING_D, "no_image"],
    ]);
    expect(s.model).toMatchObject({ id: "google/siglip2-base-patch16-384", revision: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(s.visualVerification.status).toBe("not_assessed");

    const keys: string[] = [];
    JSON.stringify(s, (key, value: unknown) => (keys.push(key), value));
    for (const forbidden of ["designSimilarityIndex", "confidence", "classification"]) expect(keys).not.toContain(forbidden);
    expect(JSON.stringify(s)).not.toContain(dir);

    const saved = join(dir, "evals/local/shortlists", `${TEST_CASE}-siglip2-base-patch16-384`);
    expect(JSON.parse(await readFile(`${saved}.json`, "utf8"))).toEqual(s);
    const md = await readFile(`${saved}.md`, "utf8");
    expect(md).toContain("| 1 | 0000000002 | [[TEST] Bed B](https://www.alibaba.com/product-detail/TEST-Bed-B_0000000002.html) | 0.8300 |");
    expect(md).not.toContain(dir);
  });

  it("uses the fallback image when the primary is unusable, and never invents a score", async () => {
    await writeTestCase(dir, testManifest(), ["a.png", "b-gallery.png"]);
    const r = fakeRunner({ [LISTING_B]: 0.5 });
    const c = cli(r);
    expect(await c.run(...args, "--json", "--no-save")).toBe(SHORTLIST_EXIT_OK);
    const s = JSON.parse(c.text()) as VisualShortlist;
    expect(s.shortlist.map((e) => e.listingId)).toEqual([LISTING_B]);
    expect(s.shortlist[0].image).toMatchObject({ ref: `${TEST_CASE}/b-gallery.png`, fallback: true });
    expect(s.shortlist[0].rejectedImages.map((x) => x.problem)).toEqual(["missing_file", "remote_url_not_fetched"]);
    // Listing A was offered but could not be decoded (per the runner): excluded, not scored 0.
    const a = s.excluded.find((x) => x.listingId === LISTING_A)!;
    expect(a).toMatchObject({ reason: "no_usable_image", rejectedImages: [{ problem: "decode_failed" }] });
    expect(await readdir(dir)).not.toContain("evals");
  });

  it("handles an empty candidate set without running the model", async () => {
    await writeTestCase(dir, { ...testManifest(), candidates: [], suppliers: [] });
    const r = fakeRunner({});
    const c = cli(r);
    expect(await c.run(...args, "--no-save")).toBe(SHORTLIST_EXIT_OK);
    expect(r.requests).toEqual([]);
    expect(c.text()).toContain("No model ran");
    expect(c.text()).toContain("No candidates were ranked");
  });

  it("reports missing input, wrong associations and unsafe evidence", async () => {
    const r = fakeRunner({});
    const missing = cli(r);
    expect(await missing.run(...args, "--dry-run")).toBe(SHORTLIST_EXIT_USAGE);

    await writeTestCase(dir, { ...testManifest(), fingerprintId: "fp-other" });
    const wrong = cli(r);
    expect(await wrong.run(...args, "--dry-run")).toBe(SHORTLIST_EXIT_INVALID);
    expect(wrong.err.join("\n")).toContain("prepared from another run");

    const unsafe = testManifest();
    unsafe.candidates[0] = { ...unsafe.candidates[0], images: [{ localPath: "elsewhere/a.png" }] };
    await writeFile(join(dir, "candidates", `${TEST_CASE}.json`), JSON.stringify(unsafe));
    const u = cli(r);
    expect(await u.run(...args, "--dry-run")).toBe(SHORTLIST_EXIT_INVALID);
    expect(u.err.join("\n")).toContain("not inside the evidence folder");

    await writeFile(join(dir, "candidates", `${TEST_CASE}.json`), JSON.stringify(testManifest()));
    await writeFile(join(dir, "photos", "reference.png"), "not the analysed photograph");
    const ref = cli(r);
    expect(await ref.run(...args, "--dry-run")).toBe(SHORTLIST_EXIT_INVALID);
    expect(ref.err.join("\n")).toContain("SHA-256 differs");
    expect(r.requests).toEqual([]);
  });

  it("reports Python failures without producing scores or a report", async () => {
    await writeTestCase(dir);
    const failing: ImageSimilarityRunner = {
      embed: async () => {
        throw new EmbeddingServiceError("model_not_cached", "google/siglip2-base-patch16-384 is not in the local model cache", 3);
      },
      environment: async () => {
        throw new Error("unused");
      },
    };
    const c = cli(failing);
    expect(await c.run(...args)).toBe(SHORTLIST_EXIT_EMBEDDING);
    expect(c.err.join("\n")).toContain("embedding failed [model_not_cached]");
    expect(c.err.join("\n")).toContain("No scores were produced");
    expect(c.text()).not.toMatch(/cosine|Visual shortlist/);
    expect(await readdir(dir)).not.toContain("evals");
  });
});
