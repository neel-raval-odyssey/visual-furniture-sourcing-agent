import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleResultsView } from "@/components/sourcing/simple/results";
import { POST as cataloguePOST } from "../../../../app/api/sourcing/catalogue/[caseId]/route";
import { candidateManifestSchema, type CandidateManifest } from "../../discovery/curated/manifest";
import { loadJournal } from "../../discovery/providers/apify/run-journal";
import { CATALOGUE_SNAPSHOT, type CatalogueMatch, type CatalogueSearchSummary } from "../../discovery/providers/local-catalogue/catalogue";
import { imageBytes, LISTING_A, LISTING_B, LISTING_C, LISTING_D, orchestrationManifest } from "../../orchestration/test-fixtures";
import { TEST_CASE } from "../../shortlisting/test-fixtures";
import { makePng } from "../../verification/openai/test-fixtures";
import { getRun } from "../data";
import { analysedUploadReference, fakeSiglip } from "../intake/test-fixtures";
import { startOfflineRun } from "../offline-run";
import { localRequest, makeUiRepo } from "../test-fixtures";
import { automaticSearchPlan, startAutomaticSearch } from "./automatic-search";
import { listCatalogueSearches, startCatalogueSearch } from "./catalogue-search";
import { loadSavedFingerprint } from "../../understanding/saved/saved-fingerprint";

/**
 * The local catalogue over TEST-ONLY records in the real schemas: the
 * live-shaped [TEST] bed case (two products with photos and saved Sol records,
 * one with a remote image only, one without images) plus extra [TEST]
 * manifests written per test. No genuine listing, photo or model output.
 */

const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no marketplace, image-download or model request
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(ctx.root, { recursive: true, force: true });
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const candidatesDir = () => join(ctx.local, "candidates");
const searchDir = (caseId: string, id: string) => join(ctx.local, "discovery", caseId, id);
async function readJsonFile<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/** A completed [TEST] manifest for another saved collection, valid in the real schema. */
function otherManifest(caseId: string, products: { n: number; title: string; image?: string; category?: string }[], dataSource: "live" | "mock" = "live"): CandidateManifest {
  const value = {
    manifestType: "alibaba_candidate_manifest",
    schemaVersion: 1,
    dataSource,
    caseId,
    referenceImageId: `ref-${caseId}`,
    fingerprintId: `fp-${caseId}`,
    capture: { status: "completed", method: "operator_assisted", capturedAt: "2026-10-20T09:00:00.000Z", tools: ["alibaba_image_search"], queriesTyped: [] },
    suppliers: [],
    candidates: products.map((p) => ({
      listingUrl: `https://${dataSource === "mock" ? "www.example.com" : "www.alibaba.com"}/product-detail/TEST-Item-${p.n}_99000000${String(p.n).padStart(4, "0")}.html`,
      title: p.title,
      ...(p.category ? { category: p.category } : {}),
      images: p.image ? [{ localPath: `${caseId}/${p.image}`, role: "primary" }] : [],
    })),
  };
  return candidateManifestSchema.parse(value);
}

async function writeOther(caseId: string, manifest: CandidateManifest, files: Record<string, Uint8Array | string> = {}) {
  await writeFile(join(candidatesDir(), `${caseId}.json`), JSON.stringify(manifest));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(candidatesDir(), caseId), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(candidatesDir(), caseId, name), bytes);
}

async function snapshotOf(caseId: string, id: string) {
  return (await readJsonFile<{ items: CatalogueMatch[] }>(join(searchDir(caseId, id), CATALOGUE_SNAPSHOT))).items;
}

async function treeHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out[p.slice(dir.length)] = sha(await readFile(p));
    }
  }
  return out;
}

describe("local catalogue search", () => {
  it("selects the saved records of the same furniture type, copies their checked photos and records provenance", async () => {
    await writeOther("test-chairs", otherManifest("test-chairs", [{ n: 1, title: "[TEST] Curved Back Dining Chair", image: "c1.png" }]), { "c1.png": makePng(30, 30, 90) });
    const before = await treeHashes(candidatesDir());
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    expect(out).toMatchObject({ ok: true, reusedSearch: false, products: 4, withPhoto: 2 });
    if (!out.ok) return;
    const dir = searchDir(TEST_CASE, out.discoveryId);
    const journal = await loadJournal(dir);
    expect(journal).toMatchObject({ status: "completed", dataSource: "live", provider: { providerId: "local-catalogue", service: "local_catalogue", access: "local_catalogue" }, request: { costCapUsd: 0 } });
    expect(journal.runs[0]).toMatchObject({ state: "succeeded", usageTotalUsd: 0, snapshotFile: CATALOGUE_SNAPSHOT });

    const manifest = candidateManifestSchema.parse(await readJsonFile(join(dir, `${TEST_CASE}.json`)));
    expect(manifest.capture).toMatchObject({ method: "provider_api", tools: ["provider_catalogue_search"], provider: { access: "local_catalogue" } });
    expect(manifest.candidates.map((c) => c.title)).toEqual(["[TEST] Bed A", "[TEST] Bed B", "[TEST] Bed C (remote image only)", "[TEST] Bed D (no images)"]);
    // Photos: the primary image, copied byte for byte under its hash; remote-only and image-less products stay leads.
    const a = manifest.candidates[0].images.find((i) => "localPath" in i) as { localPath: string };
    const b = manifest.candidates[1].images.find((i) => "localPath" in i) as { localPath: string };
    expect(sha(await readFile(join(dir, a.localPath)))).toBe(sha(imageBytes("a.png")));
    expect(sha(await readFile(join(dir, b.localPath)))).toBe(sha(imageBytes("b-primary.png")));
    expect(manifest.candidates[2].images.every((i) => "url" in i)).toBe(true);
    expect(manifest.candidates[3].images).toEqual([]);
    // Supplier, price and minimum order copied as recorded, never invented.
    const original = orchestrationManifest();
    expect(manifest.candidates[0].price).toEqual(original.candidates[0].price);
    expect(manifest.suppliers.map((s) => s.name)).toEqual(["[TEST] Supplier A", "[TEST] Supplier B"]);
    expect(manifest.candidates[2].supplierRef).toBeUndefined();

    const items = await snapshotOf(TEST_CASE, out.discoveryId);
    const bedA = items.find((x) => x.title === "[TEST] Bed A")!;
    expect(bedA).toMatchObject({ decision: "selected", rank: 1, productType: "bed", typeMatch: "same_type", origin: { manifest: `evals/local/candidates/${TEST_CASE}.json`, caseId: TEST_CASE, index: 0 } });
    expect(bedA.origin.manifestSha256).toBe(sha(await readFile(join(candidatesDir(), `${TEST_CASE}.json`))));
    expect(bedA.photo).toMatchObject({ status: "copied", originalPath: `evals/local/candidates/${TEST_CASE}/a.png`, sha256: sha(imageBytes("a.png")) });
    expect(items.find((x) => x.title.includes("Chair"))).toMatchObject({ decision: "different_type", reason: "a chair, not a bed" });

    const summary = await readJsonFile<CatalogueSearchSummary>(join(dir, "import-summary.json"));
    expect(summary.counts).toMatchObject({ considered: 5, selected: 4, differentType: 1, withLocalImage: 2, withSupplier: 2 });
    expect(summary.externalRequests).toBe(0);
    // The saved collections are only read.
    expect(await treeHashes(candidatesDir())).toEqual(before);
  });

  it("never returns another furniture type to fill the page: a chair photo with only beds saved gets an honest empty result", async () => {
    const { caseId } = await analysedUploadReference(ctx.paths);
    const out = await startCatalogueSearch(ctx.paths, caseId, { runner: fakeSiglip() });
    expect(out).toMatchObject({ ok: true, products: 0, withPhoto: 0, runId: null });
    const [view] = await listCatalogueSearches(ctx.paths, caseId);
    expect(view.products).toEqual([]);
    expect(view.summary!.counts).toMatchObject({ considered: 4, selected: 0, differentType: 4 });
    expect(view.summary!.reference.furnitureType).toBe("chair");
  });

  it("offers a related type (side table for a coffee table), ranked after the same type", async () => {
    const { caseId } = await analysedUploadReference(ctx.paths);
    await writeOther("test-tables", otherManifest("test-tables", [
      { n: 1, title: "[TEST] Walnut End Table" },
      { n: 2, title: "[TEST] Curved Back Dining Chair with Arms" },
      { n: 3, title: "[TEST] Wooden Arm Chair" },
    ]));
    const out = await startCatalogueSearch(ctx.paths, caseId, { runner: null });
    if (!out.ok) throw new Error(out.message);
    const items = await snapshotOf(caseId, out.discoveryId);
    expect(items.filter((x) => x.decision === "selected").map((x) => x.title)).toEqual(["[TEST] Curved Back Dining Chair with Arms", "[TEST] Wooden Arm Chair"]);
    expect(items.find((x) => x.title.includes("End Table"))?.decision).toBe("different_type");
  });

  it("handles an empty catalogue and skips invalid, unfinished and synthetic manifests with a reason", async () => {
    await rm(join(candidatesDir(), `${TEST_CASE}.json`));
    let out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    expect(out).toMatchObject({ ok: true, products: 0, runId: null });
    await writeFile(join(candidatesDir(), "broken.json"), "{ not json");
    await writeFile(join(candidatesDir(), "wrong-shape.json"), JSON.stringify({ manifestType: "alibaba_candidate_manifest", candidates: [] }));
    await writeOther("synthetic-beds", otherManifest("synthetic-beds", [{ n: 7, title: "[TEST] Synthetic Bed" }], "mock"));
    await writeOther("bed-leads", otherManifest("bed-leads", [{ n: 8, title: "[TEST] Panel Bed Frame" }]));
    out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    if (!out.ok) throw new Error(out.message);
    const [view] = await listCatalogueSearches(ctx.paths, TEST_CASE);
    expect(view.products.map((p) => p.title)).toEqual(["[TEST] Panel Bed Frame"]);
    const skipped = Object.fromEntries(view.summary!.catalogue.skipped.map((s) => [s.manifest.split("/").pop(), s.reason]));
    expect(skipped["broken.json"]).toBe("not valid JSON");
    expect(skipped["wrong-shape.json"]).toMatch(/^invalid manifest/);
    expect(skipped["synthetic-beds.json"]).toMatch(/synthetic test records are never mixed/);
  });

  it("keeps one record per product across saved lists, preferring the one with a photo", async () => {
    const dup = otherManifest("bed-copy", []);
    dup.candidates.push({ listingUrl: orchestrationManifest().candidates[0].listingUrl, images: [], title: "[TEST] Bed A (saved again, no photo)" });
    await writeOther("bed-copy", candidateManifestSchema.parse(dup));
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    if (!out.ok) throw new Error(out.message);
    const items = await snapshotOf(TEST_CASE, out.discoveryId);
    const copies = items.filter((x) => x.identity === "product:0000000001");
    expect(copies.map((x) => x.decision).sort()).toEqual(["duplicate", "selected"]);
    expect(copies.find((x) => x.decision === "selected")!.origin.caseId).toBe(TEST_CASE);
    expect(copies.find((x) => x.decision === "duplicate")!.keptFrom).toBe(`evals/local/candidates/${TEST_CASE}.json#0`);
    expect(out.products).toBe(4);
  });

  it("keeps a product whose photo is missing or not a real image as an uncompared lead", async () => {
    await writeOther("bed-photos", otherManifest("bed-photos", [
      { n: 1, title: "[TEST] Spindle Bed", image: "missing.png" },
      { n: 2, title: "[TEST] Sleigh Bed", image: "corrupt.png" },
    ]), { "corrupt.png": "[TEST] not an image" });
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    if (!out.ok) throw new Error(out.message);
    const items = await snapshotOf(TEST_CASE, out.discoveryId);
    expect(items.find((x) => x.title === "[TEST] Spindle Bed")!.photo).toEqual({ status: "unusable", attempts: [{ originalPath: "evals/local/candidates/bed-photos/missing.png", problem: "file missing" }] });
    expect(items.find((x) => x.title === "[TEST] Sleigh Bed")!.photo).toMatchObject({ status: "unusable", attempts: [{ problem: "not a readable PNG, JPEG or WebP image" }] });
    expect(out).toMatchObject({ products: 6, withPhoto: 2 });
  });
});

describe("catalogue search → local comparison → results", () => {
  it("runs SigLIP once on the photos, reuses compatible saved Sol records, and a repeat recomputes nothing", async () => {
    const siglip = fakeSiglip();
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: siglip });
    if (!out.ok || !out.runId) throw new Error("no run");
    expect(out).toMatchObject({ reusedSearch: false, reusedRun: false });
    expect(siglip.requests).toHaveLength(1);
    expect(siglip.requests[0].groups.filter((g) => g.images.length)).toHaveLength(2);
    const run = (await getRun(ctx.paths, TEST_CASE, out.runId))!;
    const result = run.result!;
    expect(result.source).toMatchObject({ kind: "provider-run", acquisitionMethod: "provider_api", providers: [{ providerId: "local-catalogue", access: "local_catalogue" }] });
    expect(result.verified.map((e) => [e.listingId, e.verification.status, e.verification.designSimilarityIndex])).toEqual([
      [LISTING_A, "reused", 79],
      [LISTING_B, "reused", 55],
    ]);
    expect(result.unverified.map((e) => [e.listingId, e.imageEvidence.status])).toEqual([
      [LISTING_C, "remote_only"],
      [LISTING_D, "no_image"],
    ]);
    expect(result.stages.shortlist.state).toBe("completed");
    expect(result.externalRequestsMade).toBe(0);
    const journal = await readJsonFile<{ externalRequests: Record<string, number> }>(join(ctx.local, "sourcing-runs", TEST_CASE, out.runId, "run.json"));
    expect(journal.externalRequests).toEqual({ marketplace: 0, imageDownloads: 0, paidModel: 0 });

    // Repeating the action (double click, refresh and click again): same search, same comparison, no inference.
    const again = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: siglip });
    expect(again).toMatchObject({ ok: true, discoveryId: out.discoveryId, reusedSearch: true, runId: out.runId, reusedRun: true });
    expect(siglip.requests).toHaveLength(1);
    expect((await readdir(join(ctx.local, "discovery", TEST_CASE))).filter((n) => n.startsWith("disc-"))).toHaveLength(1);
  });

  it("leaves Sol pending (not reused) when a saved photo differs from the one assessed", async () => {
    await writeFile(join(candidatesDir(), TEST_CASE, "b-primary.png"), makePng(32, 24, 201));
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: fakeSiglip() });
    if (!out.ok || !out.runId) throw new Error("no run");
    const result = (await getRun(ctx.paths, TEST_CASE, out.runId))!.result!;
    expect(result.verified.map((e) => e.listingId)).toEqual([LISTING_A]);
    const b = result.unverified.find((e) => e.listingId === LISTING_B)!;
    expect(b.verification.status).toBe("stale");
    expect(b.retrieval.siglipRank).not.toBeNull();
    expect(result.followUps.join(" ")).toMatch(/separate, explicitly authorized operation/);
  });

  it("refuses to compare a catalogue photo that changed after the search", async () => {
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    if (!out.ok) throw new Error(out.message);
    const items = await snapshotOf(TEST_CASE, out.discoveryId);
    const copied = items.find((x) => x.photo?.status === "copied")!.photo as { localPath: string };
    await writeFile(join(searchDir(TEST_CASE, out.discoveryId), copied.localPath), makePng(32, 24, 3));
    const run = await startOfflineRun(ctx.paths, TEST_CASE, { runner: fakeSiglip() }, { kind: "automatic", discoveryId: out.discoveryId });
    if (!run.ok) throw new Error(run.message);
    expect(run.status).toBe("failed");
    const journal = await readJsonFile<{ stages: { candidates: { message: string } } }>(join(ctx.local, "sourcing-runs", TEST_CASE, run.runId, "run.json"));
    expect(journal.stages.candidates.message).toMatch(/changed after the search/);
  });

  it("keeps the hand-collected comparison and the catalogue comparison apart", async () => {
    const collection = await startOfflineRun(ctx.paths, TEST_CASE, { runner: null });
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: fakeSiglip() });
    if (!collection.ok || !out.ok || !out.runId) throw new Error("runs failed");
    expect(out.runId).not.toBe(collection.runId);
    const a = (await getRun(ctx.paths, TEST_CASE, collection.runId))!.result!;
    const b = (await getRun(ctx.paths, TEST_CASE, out.runId))!.result!;
    expect(a.source.acquisitionMethod).toBe("operator_assisted");
    expect(b.source.providers[0].access).toBe("local_catalogue");
    expect(a.source.manifestSha256).not.toBe(b.source.manifestSha256);
    const [view] = await listCatalogueSearches(ctx.paths, TEST_CASE);
    expect(view.manifestSha256).toBe(b.source.manifestSha256);
  });

  it("renders saved results the same after a refresh, labelled as the saved catalogue, with details (not Compare) for products without a photo", async () => {
    const out = await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: fakeSiglip() });
    if (!out.ok || !out.runId) throw new Error("no run");
    const render = async () => text(renderToStaticMarkup(<SimpleResultsView caseId={TEST_CASE} runId={out.runId!} result={(await getRun(ctx.paths, TEST_CASE, out.runId!))!.result} />));
    const first = await render();
    expect(await render()).toBe(first);
    expect(first).toContain("selected from product records already saved on this computer");
    expect(first).toContain("Searching saved catalogue");
    expect(first).toContain("Candidate photographs checked");
    expect(first).toContain("Comparing furniture designs locally");
    expect(first).toContain("Detailed verification reused");
    expect(first).toContain("Results ready");
    expect(first).toContain("View product details");
    expect(first).not.toMatch(/\d+(\.\d+)?\s?%/);
    expect(first).not.toMatch(/found (?:by|through) (?:a )?live/i);
    expect((await readdir(join(ctx.local, "sourcing-runs", TEST_CASE))).length).toBe(1);
  });

  it("does not loosen the marketplace gate: live Alibaba discovery stays blocked", async () => {
    await startCatalogueSearch(ctx.paths, TEST_CASE, { runner: null });
    const saved = await loadSavedFingerprint(join(ctx.local, "predictions", `${TEST_CASE}.json`), TEST_CASE);
    const plan = await automaticSearchPlan(ctx.paths, saved, { env: { EXA_API_KEY: "exa-test-present" } });
    expect(plan.eligibility.eligible).toBe(false);
    expect(plan.eligibility.checks.find((c) => c.key === "policy")?.ok).toBe(false);
    const start = await startAutomaticSearch(ctx.paths, TEST_CASE, { requestKey: crypto.randomUUID(), confirmed: true }, { env: { EXA_API_KEY: "exa-test-present" } });
    expect(start).toMatchObject({ ok: false, code: "not_eligible" });
  });
});

describe("catalogue route", () => {
  it("is local-only and POST-JSON only, and searches without any outbound request", async () => {
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
    const call = (init: Parameters<typeof localRequest>[1]) =>
      cataloguePOST(localRequest(`/api/sourcing/catalogue/${TEST_CASE}`, { method: "POST", ...init }), { params: Promise.resolve({ caseId: TEST_CASE }) });
    expect((await call({ origin: "https://evil.example", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "search" }) })).status).toBe(403);
    expect((await call({ headers: { "content-type": "text/plain" }, body: "search" })).status).toBe(415);
    expect((await call({ headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete" }) })).status).toBe(400);
  });
});
