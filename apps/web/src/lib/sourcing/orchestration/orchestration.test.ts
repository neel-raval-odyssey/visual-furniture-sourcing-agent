import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSourceAutoCli, SOURCE_AUTO_EXIT_BLOCKED, SOURCE_AUTO_EXIT_INVALID, SOURCE_AUTO_EXIT_OK, SOURCE_AUTO_EXIT_PARTIAL, SOURCE_AUTO_EXIT_USAGE } from "../cli/source-auto";
import { REPO_ROOT } from "../discovery/curated/test-fixtures";
import { createJournal } from "../discovery/providers/apify/discovery-run";
import { saveJournal, writeJsonAtomic } from "../discovery/providers/apify/run-journal";
import { product } from "../discovery/providers/apify/test-fixtures";
import { liveShapedRunRecord } from "../discovery/curated/test-fixtures";
import { savedFingerprintFromRecord } from "../understanding/saved/saved-fingerprint";
import type { ImageSimilarityRunner } from "../shortlisting/embedding-client";
import { fakeResponse, sha256, TEST_CASE } from "../shortlisting/test-fixtures";
import { syntheticRawVerification } from "../verification/openai/test-fixtures";
import type { SourcingResult } from "./assemble";
import {
  COMMIT,
  imageBytes,
  LISTING_A,
  LISTING_B,
  LISTING_C,
  LISTING_D,
  readJson,
  REF_PNG,
  savedShortlist,
  writeOrchestrationCase,
  writeSavedShortlist,
  writeSolRecord,
} from "./test-fixtures";

let dir: string;
const fetchSpy = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-orch-"));
  vi.stubGlobal("fetch", fetchSpy);
  await writeOrchestrationCase(dir);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function fakeRunner(opts: { cached?: boolean; revision?: string } = {}) {
  const runner = {
    embed: vi.fn(async (request: Parameters<ImageSimilarityRunner["embed"]>[0]) =>
      fakeResponse(request, Object.fromEntries(request.groups.map((g, i) => [g.id, 0.9 - i * 0.05]))),
    ),
    environment: vi.fn(async () => ({
      status: "ok" as const,
      runtime: { python: "3.13", torch: "t", transformers: "t" },
      imageFormats: {},
      device: { auto: "cpu", reason: "test" },
      model: { id: "google/siglip2-base-patch16-384", cached: opts.cached ?? true, revision: opts.cached === false ? null : (opts.revision ?? COMMIT) },
    })),
  };
  return runner;
}

function cli(runner: ImageSimilarityRunner | null = fakeRunner()) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join("\n"),
    run: (...argv: string[]) =>
      runSourceAutoCli(
        [
          ...argv,
          ...(argv.includes("--predictions") ? [] : ["--predictions", "predictions"]),
          "--images",
          "images.json",
          "--verifications-dir",
          "verifications",
          "--shortlists-dir",
          "shortlists",
          "--runs-dir",
          "runs",
        ],
        { cwd: dir, repoRoot: dir, runner, now: () => new Date(), io: { out: (l) => out.push(l), err: (l) => err.push(l) } },
      ).then((code) => {
        lastRunId = /# Sourcing run (src-\S+):/.exec(out.join("\n"))?.[1] ?? lastRunId;
        return code;
      }),
  };
}

const curated = ["--case", TEST_CASE, "--source", "curated", "--manifest", `candidates/${TEST_CASE}.json`];
/** The run a CLI call produced, taken from its output (run ids made in the same second do not sort by time). */
let lastRunId: string | undefined;
async function lastResult(caseId = TEST_CASE): Promise<{ result: SourcingResult; runDir: string }> {
  const runDir = join(dir, "runs", caseId, lastRunId!);
  return { result: await readJson(join(runDir, "result.json")), runDir };
}

async function fullCase() {
  await writeSavedShortlist(dir);
  await writeSolRecord(dir, { listingId: LISTING_A, imageFile: "a.png", raw: syntheticRawVerification({ design_similarity_index: 79, classification: "close_variant" }) });
  await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png", raw: syntheticRawVerification({ design_similarity_index: 55, classification: "similar_alternative" }) });
}

describe("source:auto — curated source", () => {
  it("plans without writing anything or calling a model", async () => {
    await fullCase();
    const runner = fakeRunner();
    const c = cli(runner);
    expect(await c.run(...curated, "--plan")).toBe(SOURCE_AUTO_EXIT_OK);
    expect(c.text()).toContain("shortlist: reused");
    expect(c.text()).toContain("verification: reused — 2 reused; 0 new paid request(s) needed; 0 sent");
    expect(runner.embed).not.toHaveBeenCalled();
    expect(await readdir(dir)).not.toContain("runs");
  });

  it("assembles a result from reused SigLIP and Sol outputs, ordered by the Sol index, with nothing external", async () => {
    await fullCase();
    const runner = fakeRunner();
    const c = cli(runner);
    expect(await c.run(...curated, "--run", "--offline")).toBe(SOURCE_AUTO_EXIT_PARTIAL); // C and D have no usable image
    expect(runner.embed).not.toHaveBeenCalled();
    const { result: r, runDir } = await lastResult();
    expect(r.verified.map((e) => [e.listingId, e.verification.verificationRank, e.verification.designSimilarityIndex, e.retrieval.siglipRank])).toEqual([
      [LISTING_A, 1, 79, 2],
      [LISTING_B, 2, 55, 1],
    ]);
    // Unverified candidates stay visible, are never scored, and keep their reasons.
    expect(r.unverified.map((e) => [e.listingId, e.verification.status, e.imageEvidence.status, e.verification.designSimilarityIndex])).toEqual([
      [LISTING_C, "not_eligible", "remote_only", null],
      [LISTING_D, "not_eligible", "no_image", null],
    ]);
    expect(r.counts).toMatchObject({ candidates: 4, withLocalImage: 2, verified: 2, unverified: 2 });
    const a = r.verified[0];
    expect(a.verification.partialStructuralDifferences.map((x) => x.feature)).toEqual(["Headboard Arch Count"]);
    expect(a.verification.structuralMismatches.map((x) => x.feature)).toEqual(["leg_profile"]);
    expect(a.supplier).toMatchObject({ name: "[TEST] Supplier A", profileUrl: "https://testsupplier-a.en.alibaba.com/" });
    expect(a.product.price).toEqual({ min: 1200.5, max: 1500, currency: "INR", unit: "piece" }); // as recorded, not converted
    expect(a.product.priceTiers).toEqual([{ minQuantity: 2, maxQuantity: 49, price: 1500, currency: "INR" }]);
    expect(r.verified[1].product.price).toBeNull();
    expect(r.verified[1].product.missingFields).toContain("price");
    expect(a.provenance.acquisitionMethod).toBe("operator_assisted");
    expect(r.externalRequestsMade).toBe(0);
    expect(r.recordedUsage).toEqual({ solResponses: 2, inputTokens: 2000, outputTokens: 1000, reasoningTokens: 400 });
    const md = await readFile(join(runDir, "result.md"), "utf8");
    expect(md).toContain("| 1 | [0000000001](https://www.alibaba.com/product-detail/TEST-Bed-A_0000000001.html) | 79 | close_variant |");
    expect(md).toContain("Partial structural differences");
    expect(md).toContain("never treated as non-matches");
    const journal = await readJson(join(runDir, "run.json"));
    expect(journal).toMatchObject({ status: "partial", externalRequests: { marketplace: 0, imageDownloads: 0, paidModel: 0 } });
    expect(journal.inputIdentity).toMatch(/^[0-9a-f]{64}$/);

    // Same inputs again: a new run id, the same result, and the earlier run reported as identical.
    const again = cli(runner);
    await again.run(...curated, "--run", "--offline");
    expect(again.text()).toContain("Earlier runs with identical inputs");
    const second = await lastResult();
    expect(second.result.verified.map((e) => e.listingId)).toEqual(r.verified.map((e) => e.listingId));
    expect(second.runDir).not.toBe(runDir);
  });

  it("keeps an equal Sol index tie in listing-id order and never mixes in SigLIP", async () => {
    await writeSavedShortlist(dir);
    await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png", raw: syntheticRawVerification({ design_similarity_index: 60, classification: "similar_alternative" }) });
    await writeSolRecord(dir, { listingId: LISTING_A, imageFile: "a.png", raw: syntheticRawVerification({ design_similarity_index: 60, classification: "similar_alternative" }) });
    await cli().run(...curated, "--run", "--offline");
    const { result } = await lastResult();
    expect(result.verified.map((e) => e.listingId)).toEqual([LISTING_A, LISTING_B]); // tie → listing id, although B ranks first in SigLIP
  });
});

describe("source:auto — reuse and invalidation", () => {
  it("does not reuse a shortlist whose image or checkpoint changed; recomputes locally only with a cached checkpoint", async () => {
    await writeSavedShortlist(dir, savedShortlist({ model: { id: "google/siglip2-so400m-patch14-384", revision: COMMIT } }));
    const noModel = cli(fakeRunner({ cached: false }));
    await noModel.run(...curated, "--plan");
    expect(noModel.text()).toMatch(/shortlist: blocked — .*not available \(nothing is downloaded automatically\)/);

    const runner = fakeRunner();
    expect(await cli(runner).run(...curated, "--run", "--offline", "--no-recompute")).toBe(SOURCE_AUTO_EXIT_PARTIAL);
    expect(runner.embed).not.toHaveBeenCalled();

    const c = cli(runner);
    await c.run(...curated, "--run", "--offline");
    expect(runner.embed).toHaveBeenCalledTimes(1);
    const { result, runDir } = await lastResult();
    expect(result.stages.shortlist.state).toBe("completed");
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(["shortlist.json", "shortlist.md", "result.json"]));
    // The saved shortlist file was not touched.
    expect((await readJson(join(dir, "shortlists", `${TEST_CASE}-siglip2-base-patch16-384.json`))).model.id).toBe("google/siglip2-so400m-patch14-384");

    await writeFile(join(dir, "candidates", TEST_CASE, "a.png"), imageBytes("changed!"));
    await writeSavedShortlist(dir);
    const changed = cli(fakeRunner());
    await changed.run(...curated, "--plan", "--no-recompute");
    expect(changed.text()).toContain("alibaba-product-0000000001 image changed");
  });

  it("classifies Sol records: failed, interrupted, stale, ambiguous and missing are never reused or retried", async () => {
    await writeSavedShortlist(dir);
    await writeSolRecord(dir, { listingId: LISTING_A, imageFile: "a.png", status: "incomplete" });
    await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png", instructionsVersion: "2026-01-01.1" });
    const c = cli();
    await c.run(...curated, "--run", "--offline");
    const { result } = await lastResult();
    const status = Object.fromEntries(result.unverified.map((e) => [e.listingId, [e.verification.status, e.verification.notes.join(" ")]]));
    expect(status[LISTING_A][0]).toBe("failed");
    expect(status[LISTING_B]).toEqual(["stale", "instructions 2026-01-01.1"]);
    expect(result.selection.paidRequestsNeeded).toBe(1); // only the stale one is "needed"; the failed one needs a deliberate --rerun
    expect(c.text()).toContain(`pnpm verify:visual --case ${TEST_CASE} --candidates candidates --listing-id ${LISTING_B} --live --max-paid-requests 1`);
    expect(c.text()).toContain("it is not retried automatically");

    await writeSolRecord(dir, { listingId: LISTING_A, imageFile: "a.png", status: "requested", requestedAt: "2026-10-27T11:00:00.000Z" });
    await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png" });
    await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png" });
    await cli().run(...curated, "--run", "--offline");
    const second = (await lastResult()).result;
    expect(second.unverified.find((e) => e.listingId === LISTING_A)!.verification.status).toBe("interrupted");
    expect(second.unverified.find((e) => e.listingId === LISTING_B)!.verification.status).toBe("ambiguous");
    await cli().run(...curated, "--run", "--offline", "--prefer-latest-verification");
    expect((await lastResult()).result.verified.map((e) => e.listingId)).toEqual([LISTING_B]);
  });

  it("records top-K exclusions with ranks and keeps reusable assessments of excluded candidates", async () => {
    await fullCase();
    await cli().run(...curated, "--run", "--offline", "--selection", "top-k", "--top-k", "1");
    const { result } = await lastResult();
    expect(result.selection.excluded).toEqual([{ listingId: LISTING_A, siglipRank: 2, cosine: 0.83, reason: "SigLIP rank 2 is outside top 1", everVerified: true }]);
    expect(result.verified.map((e) => e.listingId)).toEqual([LISTING_A, LISTING_B]);
    expect(result.verified[0].verification.selected).toBe(false);
  });
});

describe("source:auto — reference and image evidence", () => {
  it("fails on a missing fingerprint, a changed photo or a non-furniture record; never calls Luna", async () => {
    expect(await cli().run(...curated, "--plan", "--predictions", "nowhere")).toBe(SOURCE_AUTO_EXIT_BLOCKED);
    await writeFile(join(dir, "photos", "reference.png"), imageBytes("other"));
    const changed = cli();
    expect(await changed.run(...curated, "--plan")).toBe(SOURCE_AUTO_EXIT_INVALID);
    expect(changed.text()).toMatch(/reference: failed — .*does not match the image the saved fingerprint was made from/);
    await writeFile(join(dir, "photos", "reference.png"), REF_PNG);
    const landscape = cli();
    await landscape.run("--case", "syn-landscape-001", "--source", "curated", "--plan", "--synthetic", "--predictions", join(REPO_ROOT, "evals/image-understanding/synthetic/predictions"));
    expect(landscape.text()).toMatch(/reference: failed — .*no fingerprint/);
    await writeFile(join(dir, "predictions", `${TEST_CASE}.json`), "{ broken");
    const broken = cli();
    await broken.run(...curated, "--plan");
    expect(broken.text()).toMatch(/reference: failed — .*not valid JSON/);
  });

  it("distinguishes missing, corrupt, remote-only and unsafe images without inventing similarity", async () => {
    await writeFile(join(dir, "candidates", TEST_CASE, "a.png"), imageBytes("a.png").subarray(0, 40));
    await rm(join(dir, "candidates", TEST_CASE, "b-primary.png"));
    await rm(join(dir, "candidates", TEST_CASE, "b-gallery.png"));
    await cli().run(...curated, "--run", "--offline");
    const { result } = await lastResult();
    const ev = Object.fromEntries(result.unverified.map((e) => [e.listingId, e.imageEvidence.status]));
    expect(ev).toEqual({ [LISTING_A]: "corrupt", [LISTING_B]: "missing_file", [LISTING_C]: "remote_only", [LISTING_D]: "no_image" });
    expect(result.verified).toEqual([]);
    expect(result.stages.shortlist.state).toBe("skipped");

    await rm(join(dir, "candidates", TEST_CASE, "a.png"));
    await mkdir(join(dir, "outside"), { recursive: true });
    await writeFile(join(dir, "outside", "x.png"), imageBytes("x"));
    await symlink(join(dir, "outside", "x.png"), join(dir, "candidates", TEST_CASE, "a.png"));
    await cli().run(...curated, "--run", "--offline");
    expect((await lastResult()).result.unverified.find((e) => e.listingId === LISTING_A)!.imageEvidence.status).toBe("rejected_security");
  });
});

describe("source:auto — saved and live provider sources", () => {
  const syntheticRun = join(REPO_ROOT, "evals/discovery/synthetic/syn-bed-001/disc-2026-10-27T00-00-00Z-000000");
  const synArgs = ["--case", "syn-bed-001", "--synthetic", "--predictions", join(REPO_ROOT, "evals/image-understanding/synthetic/predictions"), "--source", "provider-run", "--discovery-run", syntheticRun];

  it("uses a saved synthetic discovery run offline, keeping provider diagnostics and never scoring missing images", async () => {
    const c = cli();
    expect(await c.run(...synArgs, "--run", "--offline")).toBe(SOURCE_AUTO_EXIT_PARTIAL);
    const { result } = await lastResult("syn-bed-001");
    expect(result.synthetic).toBe(true);
    expect(result.source.discovery).toMatchObject({
      state: { recordedStatus: "in_progress", externalWorkPending: false, snapshotsAvailable: 2 },
      manifestOrigin: "normalized_offline_from_snapshots",
      providerErrors: [{ mode: "image", code: "BLOCKED", message: "Request was refused; this row is not a product" }],
    });
    expect(result.counts).toMatchObject({ candidates: 6, withLocalImage: 0, verified: 0, unverified: 6 });
    expect(result.unverified.every((e) => e.verification.designSimilarityIndex === null && e.provenance.acquisitionMethod === "provider_api")).toBe(true);
    expect(result.unverified[0].provenance.providerAccess).toBe("third_party_service");
    expect(c.text()).not.toContain("--fetch-images"); // never suggested for synthetic data
  });

  async function providerRun(mutate: (j: ReturnType<typeof createJournal>["journal"]) => void) {
    const saved = savedFingerprintFromRecord(liveShapedRunRecord(), TEST_CASE);
    const { journal } = createJournal({ caseId: TEST_CASE, saved: { ...saved, record: { ...saved.record, image: { ...saved.record.image, sha256: sha256(REF_PNG) } } }, mode: "hybrid", maxResults: 10, costCapUsd: 1, maxQueries: 2, imageTransport: null, downloadImages: false, imagesPerListing: 1, now: new Date() });
    mutate(journal);
    const runDir = join(dir, "discovery", journal.discoveryId);
    await saveJournal(runDir, journal);
    return `discovery/${journal.discoveryId}`;
  }

  it("blocks on a pending provider run and fails on a failed one, never as zero products", async () => {
    const pending = await providerRun((j) => Object.assign(j.runs[0], { state: "running", providerRunId: "RunX" }));
    const p = cli();
    expect(await p.run("--case", TEST_CASE, "--source", "provider-run", "--discovery-run", pending, "--plan")).toBe(SOURCE_AUTO_EXIT_BLOCKED);
    expect(p.text()).toMatch(/candidates: blocked — .*still running or its start is unconfirmed/);

    const failed = await providerRun((j) => {
      j.status = "failed";
      j.runs.forEach((r) => Object.assign(r, { state: "start_failed", error: { category: "authentication", message: "401" } }));
    });
    const f = cli();
    expect(await f.run("--case", TEST_CASE, "--source", "provider-run", "--discovery-run", failed, "--plan")).toBe(SOURCE_AUTO_EXIT_INVALID);
    expect(f.text()).toMatch(/candidates: failed — .*not an empty result/);
  });

  async function providerRunWithSnapshot(imageItems: unknown[], keywordFails: boolean) {
    const id = await providerRun((j) => {
      j.status = "in_progress";
      Object.assign(j.runs[0], { state: "succeeded", providerRunId: "RunImage000000001", datasetId: "DsImage00000000001", snapshotFile: "provider-response-image.json", itemCount: imageItems.length, finishedAt: "2026-10-27T10:01:00.000Z" });
      if (keywordFails) Object.assign(j.runs[1], { state: "failed", providerRunId: "RunKeyword0000001", statusMessage: "Actor crashed" });
      else j.runs.pop();
    });
    await writeJsonAtomic(join(dir, id, "provider-response-image.json"), {
      recordType: "provider_response_snapshot",
      schemaVersion: 1,
      dataSource: "live",
      source: "apify:scrapewise/alibaba-com-scraper",
      mode: "image",
      providerRunId: "RunImage000000001",
      datasetId: "DsImage00000000001",
      finishedAt: "2026-10-27T10:01:00.000Z",
      fetchedAt: "2026-10-27T10:01:05.000Z",
      itemLimit: 50,
      truncated: false,
      items: imageItems,
    });
    return id;
  }

  it("uses the successful part of a partially failed hybrid run and reports the failed part as missing", async () => {
    const id = await providerRunWithSnapshot([product("live-shaped", "1000000000501")], true);
    const c = cli();
    expect(await c.run("--case", TEST_CASE, "--source", "provider-run", "--discovery-run", id, "--run", "--offline")).toBe(SOURCE_AUTO_EXIT_PARTIAL);
    const { result } = await lastResult();
    expect(result.stages.candidates.state).toBe("partial");
    expect(result.counts.candidates).toBe(1);
    expect(result.warnings.join(" ")).toContain("Provider keyword run did not succeed (failed: Actor crashed); its results are missing, not empty.");
    expect(result.unverified[0].imageEvidence.status).toBe("remote_only");
  });

  it("treats a completed empty provider search as zero candidates, distinct from a failure", async () => {
    const id = await providerRunWithSnapshot([], false);
    const c = cli();
    expect(await c.run("--case", TEST_CASE, "--source", "provider-run", "--discovery-run", id, "--run", "--offline")).toBe(SOURCE_AUTO_EXIT_PARTIAL);
    const { result } = await lastResult();
    expect(result.stages.candidates.state).toBe("completed");
    expect(result.stages.image_evidence.state).toBe("skipped");
    expect(result.counts.candidates).toBe(0);
  });

  it("reports live provider acquisition as blocked, even with credentials present", async () => {
    const c = cli();
    expect(await c.run("--case", TEST_CASE, "--source", "provider-live", "--plan")).toBe(SOURCE_AUTO_EXIT_BLOCKED);
    expect(c.text()).toContain("A --data-use-reviewed flag is not proof of authorization");
    expect(c.text()).toContain("Credentials required: APIFY_TOKEN");
    expect(await cli().run("--case", TEST_CASE, "--source", "provider-live", "--run", "--offline")).toBe(SOURCE_AUTO_EXIT_USAGE);
  });
});

describe("source:auto — run journal and resume", () => {
  it("requires --offline to execute, resumes unfinished runs, and refuses when inputs changed", async () => {
    expect(await cli().run(...curated, "--run")).toBe(SOURCE_AUTO_EXIT_USAGE);
    await writeSavedShortlist(dir);
    await cli().run(...curated, "--run", "--offline"); // partial: no Sol records yet
    const { runDir } = await lastResult();
    const runId = runDir.split("/").at(-1)!;

    await writeSolRecord(dir, { listingId: LISTING_A, imageFile: "a.png" });
    await writeSolRecord(dir, { listingId: LISTING_B, imageFile: "b-primary.png" });
    const resumed = cli();
    expect(await resumed.run("--case", TEST_CASE, "--resume", runId, "--offline")).toBe(SOURCE_AUTO_EXIT_PARTIAL); // C, D still lack images
    const journal = await readJson(join(runDir, "run.json"));
    expect(journal.resumedAt).toHaveLength(1);
    expect((await readJson(join(runDir, "result.json"))).counts.verified).toBe(2);

    await writeFile(join(dir, "candidates", TEST_CASE, "a.png"), imageBytes("a changed"));
    const stale = cli();
    expect(await stale.run("--case", TEST_CASE, "--resume", runId, "--offline")).toBe(SOURCE_AUTO_EXIT_BLOCKED);
    expect(stale.text()).toMatch(/inputs changed since run .*candidateImages/);
    expect((await readJson(join(runDir, "run.json"))).resolved.candidateImages[LISTING_A]).toBe(sha256(imageBytes("a.png")));
  });
});
