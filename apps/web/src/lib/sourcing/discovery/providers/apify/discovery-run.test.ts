import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { liveShapedRunRecord } from "../../curated/test-fixtures";
import { savedFingerprintFromRecord } from "../../../understanding/saved/saved-fingerprint";
import { ApifyError, type ApifyRun } from "./apify-client";
import { advanceRuns, ApifyAlibabaDiscoveryAdapter, createJournal, describeDiscoveryState, normalizeSavedRuns, type ApifyApi } from "./discovery-run";
import { loadJournal } from "./run-journal";
import { fakeRun, imageRows, keywordRows } from "./test-fixtures";

let dir: string;
const saved = savedFingerprintFromRecord(liveShapedRunRecord(), "test-live-bed");
const clock = () => {
  let t = Date.parse("2026-10-27T10:00:00.000Z");
  return () => new Date((t += 1000));
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-discovery-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function api(overrides: Partial<Record<keyof ApifyApi, (...a: never[]) => unknown>> = {}) {
  let n = 0;
  const datasets: Record<string, unknown[]> = { DatasetImage00001: imageRows("live-shaped"), DatasetKeyword0001: keywordRows("live-shaped") };
  const client = {
    startRun: vi.fn(async (_actor: string, input: { imageUrls?: string[] }) =>
      fakeRun({ id: `Run${++n}Test000000000`, status: "RUNNING", datasetId: input.imageUrls ? "DatasetImage00001" : "DatasetKeyword0001" }),
    ),
    getRun: vi.fn(async (id: string): Promise<ApifyRun> => fakeRun({ id, datasetId: id.startsWith("Run1") ? "DatasetImage00001" : "DatasetKeyword0001" })),
    getDatasetItems: vi.fn(async (id: string) => datasets[id]),
    listRecentRuns: vi.fn(async () => []),
    ...overrides,
  };
  return client as unknown as ApifyApi & Record<keyof ApifyApi, Mock>;
}

const journalFor = (mode: "image" | "keyword" | "hybrid") =>
  createJournal({
    caseId: "test-live-bed",
    saved,
    mode,
    maxResults: 10,
    costCapUsd: 1,
    maxQueries: 2,
    imageTransport: mode === "keyword" ? null : { kind: "url", url: "https://photos.example/ref.png" },
    downloadImages: false,
    imagesPerListing: 1,
    now: new Date("2026-10-27T10:00:00.000Z"),
  }).journal;

describe("discovery run lifecycle", () => {
  it("starts each mode once, polls, saves snapshots and normalizes a hybrid run", async () => {
    const client = api();
    const journal = journalFor("hybrid");
    await advanceRuns({ client, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, journal, { startPlanned: true });
    expect(client.startRun).toHaveBeenCalledTimes(2);
    expect(client.startRun.mock.calls[0][1]).toMatchObject({ imageUrls: ["https://photos.example/ref.png"], maxItems: 10 });
    expect(client.startRun.mock.calls[0][2]).toEqual({ timeoutSecs: 300, maxTotalChargeUsd: 0.5, maxItems: 10 });
    expect(client.startRun.mock.calls[1][1]).toMatchObject({ keywords: saved.fingerprint.searchQueries.slice(0, 2) });
    expect(journal.status).toBe("in_progress");
    expect(journal.runs.map((r) => [r.mode, r.state, r.snapshotFile, r.itemCount])).toEqual([
      ["image", "succeeded", "provider-response-image.json", 11],
      ["keyword", "succeeded", "provider-response-keyword.json", 2],
    ]);
    const onDisk = await loadJournal(dir);
    expect(onDisk.runs[0].providerRunId).toBe("Run1Test000000000");
    const { build, providerErrors } = await normalizeSavedRuns(dir, onDisk, saved);
    expect(build.manifest.candidates).toHaveLength(6);
    expect(providerErrors).toHaveLength(1);
    expect(await readFile(join(dir, "run.json"), "utf8")).not.toMatch(/token|Bearer/i);
  });

  it("records an uncertain start and never starts the run again", async () => {
    const client = api({
      startRun: vi.fn(async () => {
        throw new ApifyError("timeout", "timed out");
      }),
    });
    const journal = journalFor("hybrid");
    await advanceRuns({ client, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, journal, { startPlanned: true });
    expect(client.startRun).toHaveBeenCalledTimes(1); // the keyword run is not started after an uncertain start
    expect(journal.runs.map((r) => r.state)).toEqual(["start_uncertain", "planned"]);
    expect(journal.status).toBe("pending_provider");

    await advanceRuns({ client, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, journal, { startPlanned: false });
    expect(client.startRun).toHaveBeenCalledTimes(1); // resume never starts runs
  });

  it("stops after an access error and reports failed runs instead of empty results", async () => {
    const denied = api({
      startRun: vi.fn(async () => {
        throw new ApifyError("authentication", "Apify rejected the token (401)");
      }),
    });
    const journal = journalFor("hybrid");
    await advanceRuns({ client: denied, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, journal, { startPlanned: true });
    expect(denied.startRun).toHaveBeenCalledTimes(1);
    expect(journal.runs[0]).toMatchObject({ state: "start_failed", error: { category: "authentication" } });
    expect(journal.status).toBe("failed");
    await expect(normalizeSavedRuns(dir, journal, saved)).rejects.toThrow(/No provider run has succeeded/);

    const failing = api({ getRun: vi.fn(async (id: string) => fakeRun({ id, status: "FAILED", statusMessage: "Actor crashed" })) });
    const j2 = journalFor("keyword");
    await advanceRuns({ client: failing, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, j2, { startPlanned: true });
    expect(j2.runs[0]).toMatchObject({ state: "failed", statusMessage: "Actor crashed", snapshotFile: null });
    expect(failing.getDatasetItems).not.toHaveBeenCalled();
  });

  it("leaves a slow run pending and finishes it on resume without a new start", async () => {
    let finished = false;
    const client = api({ getRun: vi.fn(async (id: string) => fakeRun({ id, status: finished ? "SUCCEEDED" : "RUNNING", datasetId: "DatasetKeyword0001" })) });
    const journal = journalFor("keyword");
    let t = Date.parse("2026-10-27T10:00:00.000Z");
    const fastClock = () => new Date((t += 20_000));
    await advanceRuns({ client, runDir: dir, now: fastClock, waitSeconds: 30, sleep: async () => {} }, journal, { startPlanned: true });
    expect(journal.status).toBe("pending_provider");
    expect(journal.runs[0].state).toBe("running");
    finished = true;
    const resumed = await loadJournal(dir);
    await advanceRuns({ client, runDir: dir, now: clock(), waitSeconds: 60, sleep: async () => {} }, resumed, { startPlanned: false });
    expect(resumed.runs[0].state).toBe("succeeded");
    expect(client.startRun).toHaveBeenCalledTimes(1);
  });

  it("returns a DiscoverySearchResult through the AlibabaDiscoveryAdapter interface", async () => {
    const client = api();
    const adapter = new ApifyAlibabaDiscoveryAdapter({
      client,
      runDir: dir,
      now: clock(),
      waitSeconds: 60,
      sleep: async () => {},
      caseId: "test-live-bed",
      saved,
      imageTransport: { kind: "url", url: "https://photos.example/ref.png" },
      costCapUsd: 1,
      maxQueries: 2,
    });
    const result = await adapter.discoverCandidates({ reference: saved.reference, fingerprint: saved.fingerprint, mode: "image", limit: 3 });
    expect(result.provider).toEqual({ providerId: "apify-alibaba-discovery", marketplace: "alibaba", dataSource: "live", acquisitionMethod: "provider_api" });
    expect(result.listings).toHaveLength(3);
    expect(result.listings[0].provenance.providerSource?.runIds).toEqual(["Run1Test000000000"]);
    for (const l of result.listings) if (l.supplierId) expect(result.suppliers.map((s) => s.id)).toContain(l.supplierId);
    await expect(adapter.discoverCandidates({ reference: { ...saved.reference, id: "ref-other" }, mode: "image", limit: 3 })).rejects.toThrow(/does not match/);
  });

  it("describes the recorded status without confusing finished work with an active job", () => {
    const finished = journalFor("hybrid");
    finished.status = "in_progress";
    finished.runs.forEach((r) => Object.assign(r, { state: "succeeded", snapshotFile: `provider-response-${r.mode}.json` }));
    expect(describeDiscoveryState(finished)).toMatchObject({
      recordedStatus: "in_progress",
      externalWorkPending: false,
      snapshotsAvailable: 2,
      manifestRecorded: false,
      meaning: "provider runs finished; results not yet normalized into a manifest in this folder",
    });
    const pending = journalFor("keyword");
    pending.runs[0].state = "start_uncertain";
    expect(describeDiscoveryState(pending)).toMatchObject({ externalWorkPending: true, meaning: expect.stringContaining("start is unconfirmed") });
  });
});
