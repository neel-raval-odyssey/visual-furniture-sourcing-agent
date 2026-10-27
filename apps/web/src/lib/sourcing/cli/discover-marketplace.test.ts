import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../discovery/curated/test-fixtures";
import { ApifyError, type ApifyRun } from "../discovery/providers/apify/apify-client";
import { fakeRun, imageRows, keywordRows } from "../discovery/providers/apify/test-fixtures";
import type { FetchedImage } from "../discovery/images/safe-image-fetch";
import type { ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { REFERENCE_BYTES, sha256, TEST_CASE, writeTestCase } from "../shortlisting/test-fixtures";
import { makePng } from "../verification/openai/test-fixtures";
import {
  DISCOVER_EXIT_INVALID,
  DISCOVER_EXIT_OK,
  DISCOVER_EXIT_PENDING,
  DISCOVER_EXIT_PROVIDER,
  DISCOVER_EXIT_USAGE,
  runDiscoverMarketplaceCli,
} from "./discover-marketplace";
import { runShortlistImagesCli } from "./shortlist-images";
import { runSourceCandidatesCli } from "./source-candidates";

const TOKEN = "apify_api_TESTTOKEN_not_real";
const REF = makePng(48, 36, 3);
let dir: string;
const globalFetch = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-discover-"));
  vi.stubGlobal("fetch", globalFetch);
  await writeTestCase(dir, undefined, [], { reference: REF });
});
afterEach(async () => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function fakeApify(opts: { start?: () => Promise<ApifyRun>; status?: ApifyRun["status"] } = {}) {
  let n = 0;
  const datasets: Record<string, unknown[]> = { DatasetImage00001: imageRows("live-shaped"), DatasetKeyword0001: keywordRows("live-shaped") };
  const datasetOf = new Map<string, string>();
  return {
    startRun: vi.fn(
      opts.start ??
        (async (_a: string, input: { imageUrls?: string[]; imageFile?: string }) => {
          const run = fakeRun({ id: `Run${++n}Test000000000`, status: "RUNNING", datasetId: input.imageUrls || input.imageFile ? "DatasetImage00001" : "DatasetKeyword0001" });
          datasetOf.set(run.id, run.datasetId);
          return run;
        }),
    ),
    getRun: vi.fn(async (id: string) => fakeRun({ id, status: opts.status ?? "SUCCEEDED", datasetId: datasetOf.get(id) ?? "DatasetKeyword0001" })),
    getDatasetItems: vi.fn(async (id: string) => datasets[id]),
    listRecentRuns: vi.fn(async () => [fakeRun({ id: "RunFoundTest000001", status: "RUNNING" })]),
    createKeyValueStore: vi.fn(async () => ({ id: "StoreTest000000001" })),
    putRecord: vi.fn(async () => {}),
    deleteKeyValueStore: vi.fn(async () => {}),
    recordUrl: (store: string, key: string) => `https://api.apify.com/v2/key-value-stores/${store}/records/${key}`,
  };
}

function harness(api = fakeApify(), env: Record<string, string> = { APIFY_TOKEN: TOKEN }) {
  const out: string[] = [];
  const err: string[] = [];
  const createClient = vi.fn(() => api);
  const fetchImage = vi.fn(async (url: string): Promise<FetchedImage> => {
    if (url.startsWith("https://photos.test/")) return { url, contentType: "image/png", bytes: REF };
    return { url, contentType: "image/png", bytes: makePng(32, 24, url.length % 200) };
  });
  return {
    api,
    out,
    err,
    createClient,
    fetchImage,
    text: () => out.join("\n"),
    run: (...argv: string[]) =>
      runDiscoverMarketplaceCli([...argv, "--predictions", "predictions", "--images", "images.json"], {
        cwd: dir,
        repoRoot: dir,
        env,
        createClient: createClient as never,
        fetchImage,
        convertAvif: null,
        now: () => new Date(),
        sleep: async () => {},
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      }),
  };
}

const live = ["--case", TEST_CASE, "--provider", "apify", "--live", "--max-results", "10", "--max-provider-cost-usd", "1", "--data-use-reviewed"];
const runDirs = async () => (await readdir(join(dir, "evals/local/discovery", TEST_CASE))).filter((d) => d.startsWith("disc-"));

describe("discover:marketplace", () => {
  it("dry run validates the reference and plans without any provider call", async () => {
    const h = harness();
    expect(await h.run("--case", TEST_CASE, "--provider", "apify", "--mode", "hybrid", "--image-transport", "apify-storage")).toBe(DISCOVER_EXIT_OK);
    const text = h.text();
    expect(text).toContain("no provider request was made");
    expect(text).toContain(`sha256 ${sha256(REF)} (matches the saved run)`);
    expect(text).toContain("NOT an official Alibaba.com API");
    expect(text).toContain("APIFY_TOKEN: set");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("UNVERIFIED with this Actor");
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.fetchImage).not.toHaveBeenCalled();
  });

  it("requires every live authorization explicitly", async () => {
    const h = harness();
    const base = ["--case", TEST_CASE, "--provider", "apify", "--live"];
    expect(await h.run(...base, "--mode", "keyword", "--max-provider-cost-usd", "1", "--data-use-reviewed")).toBe(DISCOVER_EXIT_USAGE); // no --max-results
    expect(await h.run(...base, "--mode", "keyword", "--max-results", "10", "--data-use-reviewed")).toBe(DISCOVER_EXIT_USAGE); // no cost cap
    expect(await h.run(...base, "--mode", "keyword", "--max-results", "10", "--max-provider-cost-usd", "1")).toBe(DISCOVER_EXIT_USAGE); // terms not reviewed
    expect(await h.run(...live, "--mode", "image", "--image-transport", "apify-storage")).toBe(DISCOVER_EXIT_USAGE); // no image consent
    expect(await h.run(...live, "--mode", "image", "--authorize-image-upload")).toBe(DISCOVER_EXIT_USAGE); // no transport
    expect(await h.run(...live, "--mode", "keyword", "--max-results", "500")).toBe(DISCOVER_EXIT_USAGE);
    expect(await h.run(...live, "--mode", "keyword", "--max-provider-cost-usd", "50")).toBe(DISCOVER_EXIT_USAGE);
    expect(await harness(fakeApify(), {}).run(...live, "--mode", "keyword")).toBe(DISCOVER_EXIT_USAGE); // no token
    expect(h.api.startRun).not.toHaveBeenCalled();
  });

  it("runs a keyword search end to end, saves a manifest the existing commands accept, and caches images", async () => {
    const h = harness();
    expect(await h.run(...live, "--mode", "keyword", "--download-images")).toBe(DISCOVER_EXIT_OK);
    expect(h.api.startRun).toHaveBeenCalledTimes(1);
    const [runDir] = await runDirs();
    const folder = join(dir, "evals/local/discovery", TEST_CASE, runDir);
    const files = await readdir(folder);
    expect(files.sort()).toEqual(["images.json", "import-summary.json", "provider-response-keyword.json", "run.json", TEST_CASE, `${TEST_CASE}.json`].sort());
    for (const f of ["run.json", "import-summary.json", "provider-response-keyword.json", `${TEST_CASE}.json`]) {
      expect(await readFile(join(folder, f), "utf8")).not.toContain(TOKEN);
    }
    const summary = JSON.parse(await readFile(join(folder, "import-summary.json"), "utf8"));
    expect(summary.counts).toMatchObject({ uniqueListings: 2, imagesCached: 2, listingsWithoutLocalImage: 0 });
    expect(h.text()).toContain(`pnpm source:candidates --case ${TEST_CASE} --candidates evals/local/discovery/${TEST_CASE}/${runDir} --validate`);

    // Existing commands read it without hand-editing.
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    const candidates = join("evals/local/discovery", TEST_CASE, runDir);
    expect(await runSourceCandidatesCli(["--case", TEST_CASE, "--predictions", "predictions", "--candidates", candidates, "--validate"], { cwd: dir, repoRoot: dir, io })).toBe(0);
    expect(out.join("\n")).toContain("Would import 2 listing(s)");
    expect(await runSourceCandidatesCli(["--case", TEST_CASE, "--predictions", "predictions", "--candidates", candidates, "--run"], { cwd: dir, repoRoot: dir, io })).toBe(0);
    expect(out.join("\n")).toContain("Searched by this application through a discovery provider");
    const runner: ImageSimilarityRunner = {
      embed: vi.fn(),
      environment: vi.fn(async () => ({ status: "ok" as const, runtime: { python: "t", torch: "t", transformers: "t" }, imageFormats: {}, device: { auto: "cpu", reason: "t" }, model: { id: "m", cached: true, revision: "r" } })),
    };
    const sl: string[] = [];
    expect(
      await runShortlistImagesCli(["--case", TEST_CASE, "--predictions", "predictions", "--images", "images.json", "--candidates", candidates, "--dry-run"], {
        cwd: dir,
        repoRoot: dir,
        runner,
        io: { out: (l) => sl.push(l), err: (l) => sl.push(l) },
      }),
    ).toBe(0);
    expect(sl.join("\n")).toContain("Would embed 1 reference and 2 candidate image(s)");
  });

  it("uploads the reference to the user's own Apify storage only with consent, and deletes it afterwards", async () => {
    const h = harness();
    expect(await h.run(...live, "--mode", "image", "--image-transport", "apify-storage", "--authorize-image-upload")).toBe(DISCOVER_EXIT_OK);
    const [store, key, bytes, type] = h.api.putRecord.mock.calls[0] as unknown as [string, string, Uint8Array, string];
    expect([store, key, type]).toEqual(["StoreTest000000001", `reference-${sha256(REF).slice(0, 16)}`, "image/png"]);
    expect(Buffer.from(bytes).equals(REF)).toBe(true);
    expect(h.api.startRun.mock.calls[0][1]).toMatchObject({ imageFile: `https://api.apify.com/v2/key-value-stores/StoreTest000000001/records/reference-${sha256(REF).slice(0, 16)}` });
    expect(h.api.deleteKeyValueStore).toHaveBeenCalledWith("StoreTest000000001");
    const [runDir] = await runDirs();
    const journal = JSON.parse(await readFile(join(dir, "evals/local/discovery", TEST_CASE, runDir, "run.json"), "utf8"));
    expect(journal.storageUpload.deletedAt).not.toBeNull();
  });

  it("checks a user-hosted image URL against the reference before sending it", async () => {
    const ok = harness();
    expect(await ok.run(...live, "--mode", "image", "--image-transport", "url", "--image-url", "https://photos.test/ettrick.png", "--authorize-image-upload")).toBe(DISCOVER_EXIT_OK);
    expect(ok.fetchImage).toHaveBeenCalledWith("https://photos.test/ettrick.png", ["photos.test"]);
    expect(ok.api.startRun.mock.calls[0][1]).toMatchObject({ imageUrls: ["https://photos.test/ettrick.png"] });

    const wrong = harness();
    expect(await wrong.run(...live, "--mode", "image", "--image-transport", "url", "--image-url", "https://other.test/x.png", "--authorize-image-upload")).toBe(DISCOVER_EXIT_INVALID);
    expect(wrong.err.join("\n")).toContain("does not serve the reference photograph");
    expect(wrong.api.startRun).not.toHaveBeenCalled();
  });

  it("never starts a second paid run after an uncertain start; resume attaches the run by id", async () => {
    const h = harness(
      fakeApify({
        start: async () => {
          throw new ApifyError("timeout", "Apify request timed out after 30000 ms");
        },
      }),
    );
    expect(await h.run(...live, "--mode", "keyword")).toBe(DISCOVER_EXIT_PENDING);
    expect(h.api.startRun).toHaveBeenCalledTimes(1);
    const [runDir] = await runDirs();
    const folder = join("evals/local/discovery", TEST_CASE, runDir);

    const list = harness(h.api);
    expect(await list.run("--case", TEST_CASE, "--resume", folder)).toBe(DISCOVER_EXIT_PENDING);
    expect(list.text()).toContain("RunFoundTest000001");
    expect(h.api.startRun).toHaveBeenCalledTimes(1);

    const attach = harness(h.api);
    h.api.getRun.mockImplementation(async (id: string) => fakeRun({ id, status: "SUCCEEDED", datasetId: "DatasetKeyword0001" }));
    expect(await attach.run("--case", TEST_CASE, "--resume", folder, "--provider-run-id", "RunFoundTest000001")).toBe(DISCOVER_EXIT_OK);
    expect(h.api.startRun).toHaveBeenCalledTimes(1);
    expect(attach.text()).toContain("unique listings 2");
  });

  it("reports provider failures, never as zero results", async () => {
    const h = harness(
      fakeApify({
        start: async () => {
          throw new ApifyError("authentication", "Apify rejected the token (401)");
        },
      }),
    );
    expect(await h.run(...live, "--mode", "keyword")).toBe(DISCOVER_EXIT_PROVIDER);
    expect(h.text()).toContain("start_failed");
    expect(h.text()).toContain("authentication: Apify rejected the token (401)");
    expect(h.text()).toContain("This is a failed search, not an empty result.");
    expect(h.text()).not.toMatch(/unique listings 0/);
  });

  it("replays the committed synthetic fixture offline and refuses to overwrite the run folder", async () => {
    const fixture = join(REPO_ROOT, "evals/discovery/synthetic/syn-bed-001/disc-2026-10-27T00-00-00Z-000000");
    const out: string[] = [];
    const deps = { cwd: dir, repoRoot: dir, env: {}, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) } };
    const base = ["--case", "syn-bed-001", "--predictions", join(REPO_ROOT, "evals/image-understanding/synthetic/predictions"), "--replay", fixture];
    expect(await runDiscoverMarketplaceCli([...base, "--json"], deps)).toBe(DISCOVER_EXIT_OK);
    const summary = JSON.parse(out.join("\n"));
    expect(summary.counts).toMatchObject({ uniqueListings: 6, duplicatesMerged: 1, rejectedRows: 5 });
    expect(await runDiscoverMarketplaceCli([...base, "--output-dir", fixture], deps)).toBe(DISCOVER_EXIT_USAGE);
    expect(await runDiscoverMarketplaceCli([...base, "--output-dir", "replayed"], deps)).toBe(DISCOVER_EXIT_OK);
    const manifest = JSON.parse(await readFile(join(dir, "replayed", "syn-bed-001.json"), "utf8"));
    expect(manifest).toMatchObject({ dataSource: "mock", capture: { method: "provider_api" } });
  });

  it("keeps reference-image checks: a changed photo stops the run", async () => {
    const h = harness();
    await writeTestCase(dir, undefined, [], { reference: REF });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "photos/reference.png"), REFERENCE_BYTES);
    expect(await h.run("--case", TEST_CASE, "--provider", "apify", "--mode", "keyword")).toBe(DISCOVER_EXIT_INVALID);
  });
});
