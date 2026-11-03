import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessRecordLoad, SourceEligibility } from "../../discovery/authorization";
import { loadJournal, saveJournal } from "../../discovery/providers/apify/run-journal";
import { EXA_PROVIDER_ID } from "../../discovery/providers/exa/exa-api";
import { exaResponse, exaResult, scriptedExa, testImageUrl } from "../../discovery/providers/exa/test-fixtures";
import { loadRunJournal } from "../../orchestration/journal";
import { loadSavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { makePng } from "../../verification/openai/test-fixtures";
import { getRun } from "../data";
import { completeIntake, saveEntry, startIntake } from "../intake/intake";
import { analysedUploadReference, fakeSiglip, product, productImage } from "../intake/test-fixtures";
import { startOfflineRun } from "../offline-run";
import { makeUiRepo } from "../test-fixtures";
import { automaticSearchPlan, fetchAutomaticSearchImages, listAutomaticSearches, readDiscoveryImage, resumeAutomaticSearch, startAutomaticSearch, type AutomaticSearchDeps } from "./automatic-search";

const KEY = () => crypto.randomUUID();
const globalFetch = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
let queries: string[];

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  ({ caseId } = await analysedUploadReference(ctx.paths));
  queries = (await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId}.json`), caseId)).fingerprint.searchQueries;
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(async () => {
  expect(globalFetch).not.toHaveBeenCalled(); // only the injected test transports are ever used
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

/** A test double for an eligible source (the real gate blocks Exa by project policy). */
function eligible(opts: { images?: boolean; raw?: boolean } = {}): AutomaticSearchDeps["checkAccess"] {
  const access: AccessRecordLoad = {
    state: "ok",
    record: {
      schemaVersion: 1,
      providers: {
        [EXA_PROVIDER_ID]: {
          accessBasis: "search_index_terms_review",
          agreementReference: "[TEST] review",
          reviewedBy: "test",
          reviewedAt: "2026-11-03",
          permittedModes: ["keyword"],
          imageTransferApproved: false,
          liveEnabled: true,
          maxResultsPerRun: 20,
          maxCostUsdPerRun: 0.5,
          productImageRetrievalApproved: opts.images ?? false,
          retainRawResponses: opts.raw ?? false,
        },
      },
    },
  };
  const eligibility: SourceEligibility = { providerId: EXA_PROVIDER_ID, mode: "keyword", eligible: true, checks: [], blocker: null, limits: { maxResults: 20, maxCostUsd: 0.5 } };
  return async () => ({ eligibility, access });
}

const ok = (...ns: number[]) => () => ({ status: 200, json: exaResponse(ns.map((n) => exaResult(n))) });
const pngFetch = async (url: string) => ({ url, contentType: "image/png", bytes: new Uint8Array(makePng(40, 30, Number(/TEST-(\d+)/.exec(url)?.[1] ?? 1) * 7)) });
const deps = (fetch: AutomaticSearchDeps["fetch"], extra: Partial<AutomaticSearchDeps> = {}): AutomaticSearchDeps => ({
  env: { EXA_API_KEY: "exa-test-key" },
  fetch,
  fetchImage: pngFetch,
  convertAvif: null,
  checkAccess: eligible(),
  ...extra,
});
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("eligibility", () => {
  it("the real gate blocks Exa by project policy, even with a key and a complete access record; nothing is sent", async () => {
    const exa = scriptedExa([]);
    await writeFile(
      ctx.paths.marketplaceAccess,
      JSON.stringify({
        schemaVersion: 1,
        providers: { [EXA_PROVIDER_ID]: { accessBasis: "search_index_terms_review", agreementReference: "[TEST]", reviewedBy: "t", reviewedAt: "2026-11-03", permittedModes: ["keyword"], imageTransferApproved: false, liveEnabled: true, maxResultsPerRun: 20, maxCostUsdPerRun: 1, productImageRetrievalApproved: true } },
      }),
    );
    const out = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, { env: { EXA_API_KEY: "exa-test-key" }, fetch: exa.fetch });
    expect(out).toMatchObject({ ok: false, status: 409, code: "not_eligible" });
    expect(!out.ok && out.message).toMatch(/external web search index/);
    expect(exa.calls).toHaveLength(0);
    expect(await exists(join(ctx.paths.discovery, caseId))).toBe(true);
    expect((await readdir(join(ctx.paths.discovery, caseId))).filter((n) => n.startsWith("disc-"))).toEqual([]);
  });

  it("reports missing credentials and a missing access record in the plan", async () => {
    const saved = await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId}.json`), caseId);
    const plan = await automaticSearchPlan(ctx.paths, saved, { env: {} });
    const failing = plan.eligibility.checks.filter((c) => !c.ok).map((c) => c.key);
    expect(failing).toEqual(["policy", "credentials", "access_record", "live_enabled"]);
    expect(plan.queries).toEqual(queries.slice(0, 4)); // saved Luna queries, unchanged
    expect(plan.imageRetrieval.allowed).toBe(false);
  });

  it("requires an explicit confirmation and a valid request key", async () => {
    const exa = scriptedExa([]);
    expect(await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: false }, deps(exa.fetch))).toMatchObject({ ok: false, code: "not_confirmed" });
    expect(await startAutomaticSearch(ctx.paths, caseId, { requestKey: "nope", confirmed: true }, deps(exa.fetch))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(exa.calls).toHaveLength(0);
  });
});

describe("an automatic search (synthetic provider responses)", () => {
  it("sends the saved queries unchanged, one request each, and saves a separate candidate set with provenance", async () => {
    const exa = scriptedExa([ok(1, 2, 3), ok(3, 4), ok(), ok(5)]);
    const out = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    expect(out).toMatchObject({ ok: true, reused: false, status: "completed" });
    expect(exa.calls.map((c) => c.body.query)).toEqual(queries.slice(0, 4));
    expect(exa.calls.every((c) => JSON.stringify(c.body).length < 400 && !("image" in c.body))).toBe(true);

    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.access).toBe("external_search_index");
    expect(view.summary?.counts).toMatchObject({ resultsReturned: 6, alibabaProductLinks: 6, furnitureListings: 6, uniqueProducts: 5, duplicates: 1, withImageUrl: 5, withLocalImage: 0, withSupplier: 0, withPrice: 5, withMinimumOrder: 5 });
    expect(view.summary?.imageRetrieval).toBe("not_approved");
    expect(view.summary?.costUsd.reported).toBe(0.068);
    expect(view.products[2].queries).toEqual([queries[0], queries[1]]);
    // The hand-collected list is untouched: no file was written to the curated candidates folder.
    expect(await exists(join(ctx.paths.candidates, `${caseId}.json`))).toBe(false);
    const runDir = join(ctx.paths.discovery, caseId, view.discoveryId);
    const files = (await readdir(runDir)).sort();
    expect(files).toEqual([`${caseId}.json`, "import-summary.json", "provider-response-q1.json", "provider-response-q2.json", "provider-response-q3.json", "provider-response-q4.json", "run.json"].sort());
    const journal = await loadJournal(runDir);
    expect(journal.provider).toMatchObject({ service: "exa", access: "external_search_index" });
    expect(journal.reference.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Without raw-retention approval only the used fields are kept.
    const snap = JSON.parse(await readFile(join(runDir, "provider-response-q1.json"), "utf8"));
    expect(Object.keys(snap.items[0]).sort()).toEqual(["highlights", "id", "image", "publishedDate", "title", "url"]);
  });

  it("a repeated submission with the same key returns the same search without sending again", async () => {
    const exa = scriptedExa([ok(1), ok(2), ok(3), ok(4)]);
    const key = KEY();
    const first = await startAutomaticSearch(ctx.paths, caseId, { requestKey: key, confirmed: true }, deps(exa.fetch));
    const again = await startAutomaticSearch(ctx.paths, caseId, { requestKey: key, confirmed: true }, deps(exa.fetch));
    expect(again).toMatchObject({ ok: true, reused: true, discoveryId: first.ok ? first.discoveryId : "" });
    expect(exa.calls).toHaveLength(4);
  });

  it("a second search is refused while one is unfinished (simultaneous starts send one search)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exa = scriptedExa([async () => (await gate, { status: 200, json: exaResponse([exaResult(1)]) }), ok(2), ok(3), ok(4)]);
    const a = startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    await vi.waitFor(() => expect(exa.calls.length).toBe(1));
    const b = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    expect(b).toMatchObject({ ok: false, code: "already_running" });
    release();
    expect(await a).toMatchObject({ ok: true, status: "completed" });
    expect(exa.calls).toHaveLength(4);
  });

  it("a timeout is recorded as uncertain, never re-sent, and stops further requests", async () => {
    const exa = scriptedExa([ok(1, 2), () => Object.assign(new Error("aborted"), { name: "AbortError" })]);
    // Simulate the timeout through the transport throwing after abort: use a hanging transport for request 2.
    const hang: AutomaticSearchDeps["fetch"] = async (url, init) => {
      if (exa.calls.length === 0) return exa.fetch(url, init);
      exa.calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(hang));
    await vi.waitFor(() => expect(exa.calls.length).toBe(2));
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    const out = await p;
    expect(out).toMatchObject({ ok: true, status: "completed" });
    expect(exa.calls).toHaveLength(2);
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.summary?.requests).toEqual({ planned: 4, succeeded: 1, failed: 0, uncertain: 1, notSent: 2 });
    expect(view.summary?.counts?.uniqueProducts).toBe(2); // partial result, labelled as such by the request counts
  });

  it("an interrupted search is settled on resume without re-sending; unsent queries need an explicit live resume", async () => {
    const exa = scriptedExa([ok(1), ok(2), ok(3), ok(4)]);
    const out = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    const runDir = join(ctx.paths.discovery, caseId, out.ok ? out.discoveryId : "");
    // Rewind the journal to "request 2 sent, process stopped".
    const journal = await loadJournal(runDir);
    journal.status = "in_progress";
    journal.summaryFile = null;
    journal.manifestFile = null;
    journal.runs[1] = { ...journal.runs[1], state: "start_requested", snapshotFile: null, providerRunId: null };
    journal.runs[2] = { ...journal.runs[2], state: "planned", snapshotFile: null, providerRunId: null };
    journal.runs[3] = { ...journal.runs[3], state: "planned", snapshotFile: null, providerRunId: null };
    await saveJournal(runDir, journal);
    // Meanwhile a new search is refused.
    expect(await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch))).toMatchObject({ code: "already_running" });
    const settled = await resumeAutomaticSearch(ctx.paths, caseId, journal.discoveryId, { sendRemaining: false }, deps(exa.fetch));
    expect(settled.ok).toBe(true);
    expect(exa.calls).toHaveLength(4); // nothing new was sent
    expect((await loadJournal(runDir)).runs.map((r) => [r.state, r.error?.category ?? null])).toEqual([["succeeded", null], ["failed", "uncertain"], ["planned", null], ["planned", null]]);
    const done = await resumeAutomaticSearch(ctx.paths, caseId, journal.discoveryId, { sendRemaining: true }, deps(scriptedExa([ok(7), ok(8)]).fetch));
    expect(done).toMatchObject({ ok: true, status: "completed" });
  });

  it("a rate limit stops the search: a failed search, not an empty result", async () => {
    const exa = scriptedExa([() => ({ status: 429, json: { error: "Too many requests" } })]);
    const out = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    expect(out).toMatchObject({ ok: true, status: "failed" });
    expect(exa.calls).toHaveLength(1);
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.summary?.counts).toBeNull();
    expect(view.summary?.errors[0]).toMatch(/rate_limit/);
    expect(view.products).toEqual([]);
  });

  it("empty results complete with zero products (a real empty result)", async () => {
    const exa = scriptedExa([ok(), ok(), ok(), ok()]);
    expect(await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch))).toMatchObject({ status: "completed" });
    expect((await listAutomaticSearches(ctx.paths, caseId))[0].summary?.counts?.uniqueProducts).toBe(0);
  });

  it("irrelevant domains and invalid listings are rejected with reasons, not kept", async () => {
    const exa = scriptedExa([
      () => ({ status: 200, json: exaResponse([exaResult(1), exaResult(2, { url: "https://www.example.com/p_1000000000002.html" }), exaResult(3, { url: "https://www.alibaba.com/trade/search?x=1" }), exaResult(4, { title: "[TEST] Phone case" })]) }),
      ok(),
      ok(),
      ok(),
    ]);
    await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.summary?.rejections).toEqual({ not_alibaba: 1, not_product_page: 1, not_furniture: 1 });
    expect(view.summary?.counts).toMatchObject({ resultsReturned: 4, alibabaProductLinks: 2, furnitureListings: 1, uniqueProducts: 1 });
  });
});

describe("product photos and comparison", () => {
  it("with retrieval approved, caches one checked photo per product; failures keep the lead without a photo", async () => {
    const fetchImage = vi.fn(async (url: string) => {
      if (url === testImageUrl(2)) throw Object.assign(new Error("Host resolves to a non-public address"), { name: "ImageFetchError" });
      return pngFetch(url);
    });
    const exa = scriptedExa([ok(1, 2, 3), ok(), ok(), ok()]);
    await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch, { checkAccess: eligible({ images: true }), fetchImage }));
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([testImageUrl(1), testImageUrl(2), testImageUrl(3)]);
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.summary?.counts).toMatchObject({ uniqueProducts: 3, withLocalImage: 2, imagesRejected: 1 });
    expect(view.products.map((p) => Boolean(p.localImage))).toEqual([true, false, true]);
    const img = await readDiscoveryImage(ctx.paths, caseId, view.discoveryId, 0);
    expect(img?.ok).toBe(true);
    // A changed file is refused.
    await writeFile(join(ctx.paths.discovery, caseId, view.discoveryId, view.products[0].localImage!), makePng(40, 30, 200));
    expect(await readDiscoveryImage(ctx.paths, caseId, view.discoveryId, 0)).toMatchObject({ ok: false, code: "changed" });
  });

  it("AVIF images are decoded and converted to PNG by the local converter, never renamed", async () => {
    const avif = new Uint8Array([0, 0, 0, 28, ...Buffer.from("ftypavif"), ...new Array(40).fill(1)]);
    const convertAvif = vi.fn(async (_in: string, _sha: string, out: string) => writeFile(out, makePng(40, 30, 9)));
    const exa = scriptedExa([ok(1), ok(), ok(), ok()]);
    await startAutomaticSearch(
      ctx.paths,
      caseId,
      { requestKey: KEY(), confirmed: true },
      deps(exa.fetch, { checkAccess: eligible({ images: true }), fetchImage: async (url) => ({ url, contentType: "image/avif", bytes: avif }), convertAvif }),
    );
    expect(convertAvif).toHaveBeenCalledTimes(1);
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    expect(view.products[0].localImage).toMatch(/\.png$/);
  });

  it("without retrieval approval no image is fetched, and fetching later is refused", async () => {
    const exa = scriptedExa([ok(1), ok(), ok(), ok()]);
    const fetchImage = vi.fn(pngFetch);
    const out = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch, { fetchImage }));
    expect(fetchImage).not.toHaveBeenCalled();
    const later = await fetchAutomaticSearchImages(ctx.paths, caseId, out.ok ? out.discoveryId : "", deps(exa.fetch, { fetchImage }));
    expect(later).toMatchObject({ ok: false, code: "not_eligible" });
    // Once approved, photos are prepared without repeating the search.
    const approved = await fetchAutomaticSearchImages(ctx.paths, caseId, out.ok ? out.discoveryId : "", deps(exa.fetch, { fetchImage, checkAccess: eligible({ images: true }) }));
    expect(approved.ok).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(exa.calls).toHaveLength(4);
  });

  it("compares the automatic set locally with SigLIP, separately from the hand-collected list, with no paid request", async () => {
    // A hand-collected list exists too; it must stay as it is.
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await completeIntake(ctx.paths, caseId, intakeId);
    const curated = await readFile(join(ctx.paths.candidates, `${caseId}.json`));

    const exa = scriptedExa([ok(1, 2), ok(3), ok(), ok()]);
    const fetchImage = vi.fn(async (url: string) => (url === testImageUrl(3) ? Promise.reject(new Error("http_error")) : pngFetch(url)));
    const search = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch, { checkAccess: eligible({ images: true }), fetchImage }));
    const discoveryId = search.ok ? search.discoveryId : "";
    expect((await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() }, { kind: "automatic", discoveryId: "disc-bad" })).ok).toBe(false);

    const siglip = fakeSiglip();
    const run = await startOfflineRun(ctx.paths, caseId, { runner: siglip }, { kind: "automatic", discoveryId });
    expect(run).toMatchObject({ ok: true });
    const result = (await getRun(ctx.paths, caseId, run.ok ? run.runId : ""))!.result!;
    expect(result.counts.verified).toBe(0); // no Sol request is ever made by this path
    expect(siglip.requests).toHaveLength(1);
    expect(siglip.requests[0].groups.filter((g) => g.images.length)).toHaveLength(2); // only products with a cached photo are embedded
    const entries = [...result.verified, ...result.abstained, ...result.unverified];
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.retrieval.siglipRank !== null)).toHaveLength(2); // products without a photo stay unassessed
    // The run records exactly the automatic set it used.
    const [view] = await listAutomaticSearches(ctx.paths, caseId);
    const journal = await loadRunJournal(join(ctx.paths.sourcingRuns, caseId, run.ok ? run.runId : ""));
    expect(journal.resolved.manifestSha256).toBe(view.manifestSha256);
    expect(entries.every((e) => e.provenance.providerAccess === "external_search_index")).toBe(true);
    // The hand-collected list is byte-for-byte unchanged, and its comparison is separate.
    expect(createHash("sha256").update(await readFile(join(ctx.paths.candidates, `${caseId}.json`))).digest("hex")).toBe(createHash("sha256").update(curated).digest("hex"));
    const manual = await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() });
    const manualJournal = await loadRunJournal(join(ctx.paths.sourcingRuns, caseId, manual.ok ? manual.runId : ""));
    expect(manualJournal.resolved.manifestSha256).not.toBe(view.manifestSha256);
  });

  it("refuses to compare an automatic set that has no photos", async () => {
    const exa = scriptedExa([ok(1), ok(), ok(), ok()]);
    const s = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch));
    expect(await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() }, { kind: "automatic", discoveryId: s.ok ? s.discoveryId : "" })).toMatchObject({ ok: false, code: "not_eligible" });
  });

  it("new photos for the same search change the candidate set, so an earlier comparison is not treated as current", async () => {
    const exa = scriptedExa([ok(1, 2), ok(), ok(), ok()]);
    const s = await startAutomaticSearch(ctx.paths, caseId, { requestKey: KEY(), confirmed: true }, deps(exa.fetch, { checkAccess: eligible({ images: true }), fetchImage: async (url) => (url === testImageUrl(2) ? Promise.reject(new Error("x")) : pngFetch(url)) }));
    const discoveryId = s.ok ? s.discoveryId : "";
    const before = (await listAutomaticSearches(ctx.paths, caseId))[0].manifestSha256;
    const run = await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() }, { kind: "automatic", discoveryId });
    const journal = await loadRunJournal(join(ctx.paths.sourcingRuns, caseId, run.ok ? run.runId : ""));
    expect(journal.resolved.manifestSha256).toBe(before);
    await fetchAutomaticSearchImages(ctx.paths, caseId, discoveryId, deps(exa.fetch, { checkAccess: eligible({ images: true }) }));
    const after = (await listAutomaticSearches(ctx.paths, caseId))[0];
    expect(after.products.every((p) => p.localImage)).toBe(true);
    expect(after.manifestSha256).not.toBe(before);
    // The image hashes differ from what the earlier run recorded, so the earlier shortlist would not be reused.
    const siglip = fakeSiglip();
    await startOfflineRun(ctx.paths, caseId, { runner: siglip }, { kind: "automatic", discoveryId });
    expect(siglip.requests[0].groups.filter((g) => g.images.length)).toHaveLength(2);
  });
});
