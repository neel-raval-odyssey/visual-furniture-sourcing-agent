import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as evidenceGET } from "../../../../app/api/sourcing/evidence/[...parts]/route";
import { POST as intakePOST } from "../../../../app/api/sourcing/intake/[caseId]/route";
import { SimpleResultsView } from "../../../../components/sourcing/simple/results";
import { candidateSetTag, importCuratedCandidates } from "../../discovery/curated/curated-alibaba-adapter";
import { candidateManifestSchema } from "../../discovery/curated/manifest";
import { loadSavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { makePng } from "../../verification/openai/test-fixtures";
import { getReference, getRun, listReferences } from "../data";
import { localPaths, repoRoot } from "../local-access";
import { startOfflineRun } from "../offline-run";
import { localRequest, makeUiRepo } from "../test-fixtures";
import { completeIntake, getIntakeState, IntakeProblem, publishedManifestPath, readSession, removeEntry, saveEntry, startIntake } from "./intake";
import { describeRevision, discardDraft, readCollection, setEntryImage, startRevision } from "./revision";
import { analysedUploadReference, fakeSiglip, product, productImage } from "./test-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
let existingManifest: string;

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false }); // includes an existing case with its own completed manifest
  existingManifest = await readFile(join(ctx.paths.candidates, `${ctx.caseId}.json`), "utf8");
  ({ caseId } = await analysedUploadReference(ctx.paths));
  vi.stubGlobal("fetch", fetchSpy); // no Alibaba, Apify or OpenAI request may happen
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  // The other reference's collection is never touched.
  expect(await readFile(join(ctx.paths.candidates, `${ctx.caseId}.json`), "utf8")).toBe(existingManifest);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(ctx.root, { recursive: true, force: true });
});

const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof IntakeProblem) return `${error.code}${error.field ? `:${error.field}` : ""}`;
    throw error;
  }
};

describe("a newly analysed reference", () => {
  it("is ready for intake: its own fingerprint, its staged photo and no candidates", async () => {
    const ref = await getReference(ctx.paths, caseId);
    expect(ref).toMatchObject({ understanding: "furniture_identified", readiness: "no_candidates", candidates: { state: "missing", count: 0 }, photo: { available: true } });
    expect(await getIntakeState(ctx.paths, caseId)).toEqual({ draft: null, completed: null, collectionExists: false });
  });

  it("refuses intake for a reference that already has a collection, and leaves it untouched", async () => {
    expect(await problem(startIntake(ctx.paths, ctx.caseId))).toBe("collection_exists");
    expect(await problem(startIntake(ctx.paths, "no-such-case"))).toBe("not_ready");
    expect(await problem(startIntake(ctx.paths, "../etc"))).toBe("invalid_case");
  });
});

describe("operator-assisted intake", () => {
  it("records, edits and removes products in a draft, validating every field and photo", async () => {
    const s = await startIntake(ctx.paths, caseId);
    expect((await startIntake(ctx.paths, caseId)).intakeId).toBe(s.intakeId); // reopens the draft
    const id = s.intakeId;

    const a = await saveEntry(ctx.paths, caseId, id, product(1), productImage(10));
    expect(a.entry).toMatchObject({ id: "p01", marketplaceProductId: "100000000001", price: { min: 120, max: 150.5, currency: "USD", unit: "set" }, minimumOrder: { quantity: 2, unit: "sets" }, image: { mimeType: "image/png", width: 40, height: 30 } });
    expect(a.entry.image!.sha256).toBe(createHash("sha256").update(productImage(10).bytes).digest("hex"));

    // Invalid listing URLs: lookalike host, plain http, credentials, another marketplace, not a URL.
    for (const listingUrl of ["https://www.alibaba.com.evil.example/product-detail/x_100000000009.html", "http://www.alibaba.com/product-detail/x_100000000009.html", "https://user:pw@www.alibaba.com/product-detail/x_100000000009.html", "https://detail.1688.com/offer/100000000009.html", "javascript:alert(1)"]) {
      expect(await problem(saveEntry(ctx.paths, caseId, id, product(9, { listingUrl }), null))).toBe("invalid_field:listingUrl");
    }
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9, { supplierProfileUrl: "https://alibaba.com.example.net/" }), null))).toBe("invalid_field:supplierProfileUrl");
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9, { title: "  " }), null))).toBe("invalid_field:title");
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9, { priceMin: "", currency: "USD" }), null))).toBe("invalid_field:priceMin");
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9, { moqQuantity: "1.5" }), null))).toBe("invalid_field:moqQuantity");
    // Duplicate product (same id behind a different URL form) and invalid photos.
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(1, { listingUrl: "https://www.alibaba.com/product-detail/Other-Title_100000000001.html?spm=x" }), null))).toBe("duplicate:listingUrl");
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9), { bytes: new TextEncoder().encode("not an image"), name: "x.png" }))).toBe("invalid_image:image");
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(9), { bytes: new Uint8Array(makePng(40, 30).subarray(0, 50)), name: "x.png" }))).toBe("invalid_image:image");

    // Missing optional details stay missing; a second product from the same supplier; one with no supplier.
    const b = await saveEntry(ctx.paths, caseId, id, product(2, { priceMin: null, priceMax: null, currency: null, priceUnit: null, moqQuantity: null, moqUnit: null }), productImage(20));
    expect(b.entry).toMatchObject({ price: null, minimumOrder: null, supplierName: "[TEST] Supplier One" });
    const c = await saveEntry(ctx.paths, caseId, id, product(3, { supplierName: null, supplierProfileUrl: null }), null);
    expect(c.entry).toMatchObject({ supplierName: null, image: null });

    // Edit: correct the title and replace the photo (the old photo file is removed).
    const oldFile = a.entry.image!.file;
    const edited = await saveEntry(ctx.paths, caseId, id, { ...product(1, { title: "[TEST] Nesting table 1 (corrected)" }), entryId: "p01" }, productImage(30));
    expect(edited.entry).toMatchObject({ id: "p01", title: "[TEST] Nesting table 1 (corrected)" });
    expect(edited.entry.image!.file).not.toBe(oldFile);
    expect(existsSync(join(ctx.paths.candidateIntake, caseId, id, oldFile))).toBe(false);

    // Remove a draft entry.
    await saveEntry(ctx.paths, caseId, id, product(4), productImage(40));
    const afterRemove = await removeEntry(ctx.paths, caseId, id, "p04");
    expect(afterRemove.entries.map((e) => e.id)).toEqual(["p01", "p02", "p03"]);
    expect(await problem(removeEntry(ctx.paths, caseId, id, "p04"))).toBe("unknown_entry");
  });

  it("keeps every concurrent addition", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await Promise.all([1, 2, 3, 4, 5].map((n) => saveEntry(ctx.paths, caseId, intakeId, product(n), productImage(n))));
    const s = await readSession(ctx.paths, caseId, intakeId);
    expect(s!.entries.map((e) => e.id).sort()).toEqual(["p01", "p02", "p03", "p04", "p05"]);
    expect(new Set(s!.entries.map((e) => e.marketplaceProductId)).size).toBe(5);
    expect(s!.revision).toBe(5);
  });

  it("completes into a standard operator-assisted manifest the existing intake accepts, then becomes immutable", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    expect(await problem(completeIntake(ctx.paths, caseId, intakeId))).toBe("empty");
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await saveEntry(ctx.paths, caseId, intakeId, product(2, { priceMin: null, priceMax: null, currency: null, moqQuantity: null }), productImage(20));
    await saveEntry(ctx.paths, caseId, intakeId, product(3, { supplierName: "[TEST] Supplier Two", supplierProfileUrl: null, queryUsed: "curved back dining chair", foundWith: "alibaba_keyword_search" }), null);

    const { session, summary } = await completeIntake(ctx.paths, caseId, intakeId);
    expect(session).toMatchObject({ status: "completed", published: { manifestFile: `evals/local/candidates/${caseId}.json` } });
    expect(summary).toMatchObject({ products: 3, uniqueListings: 3, suppliers: 2, withImage: 2, withoutImage: ["[TEST] Nesting table 3"], withoutPrice: 1, withoutMinimumOrder: 1, withoutSupplier: 0, eligibleForVisualShortlist: 2 });

    const manifest = candidateManifestSchema.parse(JSON.parse(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")));
    const saved = await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId}.json`), caseId);
    expect(manifest).toMatchObject({ dataSource: "live", caseId, referenceImageId: saved.reference.id, fingerprintId: saved.fingerprint.id, capture: { status: "completed", method: "operator_assisted", tools: ["alibaba_image_search", "alibaba_keyword_search"], queriesTyped: ["curved back dining chair"] } });
    expect(manifest.capture.provider ?? null).toBeNull();
    expect(manifest.suppliers.map((s) => s.name)).toEqual(["[TEST] Supplier One", "[TEST] Supplier Two"]);
    expect(manifest.candidates.map((c) => c.supplierRef)).toEqual(["supplier-1", "supplier-1", "supplier-2"]); // two products, one supplier
    expect(manifest.candidates[1]).toMatchObject({ price: null, minimumOrder: null });
    expect(manifest.candidates[2].images).toEqual([]);
    // Images published next to the manifest, byte-identical to the operator's photo.
    const img = manifest.candidates[0].images[0];
    expect("localPath" in img && img.localPath).toMatch(new RegExp(`^${caseId}/int-.*-p01\\.png$`));
    const published = await readFile(join(ctx.paths.candidates, (img as { localPath: string }).localPath));
    expect(Buffer.from(published)).toEqual(Buffer.from(productImage(10).bytes));

    // Immutable: no more edits, no second completion, no new session over a completed collection.
    expect(await problem(saveEntry(ctx.paths, caseId, intakeId, product(5), null))).toBe("completed");
    expect(await problem(completeIntake(ctx.paths, caseId, intakeId))).toBe("completed");
    expect(await problem(startIntake(ctx.paths, caseId))).toBe("collection_exists");
    expect((await getReference(ctx.paths, caseId))?.candidates).toMatchObject({ state: "completed", count: 3, acquisitionMethod: "operator_assisted" });
  });

  it("never overwrites a collection that appeared in the meantime, and publishes nothing", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await writeFile(publishedManifestPath(ctx.paths, caseId), "{\"placeholder\":true}");
    expect(await problem(completeIntake(ctx.paths, caseId, intakeId))).toBe("collection_exists");
    expect(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")).toBe("{\"placeholder\":true}");
    expect(await readdir(join(ctx.paths.candidates, caseId)).catch(() => [])).toEqual([]);
    expect((await readSession(ctx.paths, caseId, intakeId))?.status).toBe("draft");
  });
});

describe("from recorded products to a local comparison", () => {
  it("runs the existing offline workflow: its own fingerprint, local shortlist, no Sol, honest partial results", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    for (const n of [1, 2, 3]) await saveEntry(ctx.paths, caseId, intakeId, product(n, n === 3 ? { supplierName: "[TEST] Supplier Two", supplierProfileUrl: null } : {}), n === 3 ? null : productImage(n * 10));
    await completeIntake(ctx.paths, caseId, intakeId);

    const siglip = fakeSiglip();
    const outcome = await startOfflineRun(ctx.paths, caseId, { runner: siglip });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const run = await getRun(ctx.paths, caseId, outcome.runId);
    const result = run!.result!;
    const saved = await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId}.json`), caseId);

    // The new reference's own photo and fingerprint, and only its own products.
    expect(siglip.requests).toHaveLength(1);
    expect(siglip.requests[0].reference.sha256).toBe(saved.record.image.sha256);
    expect(siglip.requests[0].groups.flatMap((g) => g.images.map((i) => i.sha256)).sort()).toEqual([productImage(10), productImage(20)].map((p) => createHash("sha256").update(p.bytes).digest("hex")).sort());
    expect(result.reference.fingerprintId).toBe(saved.fingerprint.id);
    expect(result.caseId).toBe(caseId);
    expect(result.counts).toMatchObject({ candidates: 3, withLocalImage: 2, shortlisted: 2, verified: 0 });
    expect(JSON.stringify(result)).not.toContain(ctx.caseId); // no leakage from the other reference

    // Nothing verified: no design index anywhere; every product stays visible.
    expect(result.verified).toEqual([]);
    const all = [...result.abstained, ...result.unverified];
    expect(all.map((e) => e.title).sort()).toEqual(["[TEST] Nesting table 1", "[TEST] Nesting table 2", "[TEST] Nesting table 3"]);
    expect(all.every((e) => e.verification.designSimilarityIndex === null && e.verification.classification === null)).toBe(true);
    expect(all.find((e) => e.title.endsWith("3"))).toMatchObject({ imageEvidence: { status: "no_image" }, retrieval: { siglipRank: null }, supplier: { name: "[TEST] Supplier Two" } });
    expect(all.filter((e) => e.retrieval.siglipRank !== null)).toHaveLength(2);
    expect(await readdir(ctx.paths.verifications).catch(() => [] as string[])).not.toEqual(expect.arrayContaining([expect.stringContaining(caseId)]));

    // The simple results page shows them as products to compare, never as matches.
    const html = renderToStaticMarkup(<SimpleResultsView caseId={caseId} runId={outcome.runId} result={result} />);
    const page = html.replace(/<details[\s\S]*<\/details>/g, "").replace(/<[^>]+>/g, " ");
    expect(page).toContain("Products to compare");
    expect(page).toContain("Potentially similar products — detailed verification pending");
    expect(page).toContain("recorded by hand from Alibaba.com");
    expect(page).not.toMatch(/Closest design found|Close design|Similar alternative|\/100|SigLIP|cosine/);
    expect(page.indexOf("[TEST] Nesting table 1")).toBeLessThan(page.indexOf("[TEST] Nesting table 3"));
    expect((await listReferences(ctx.paths)).find((r) => r.caseId === caseId)?.readiness).toBe("results_available");
  });

  it("reports a missing local model instead of inventing scores", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await completeIntake(ctx.paths, caseId, intakeId);
    const base = fakeSiglip();
    const embed = vi.fn(base.embed);
    const runner = { ...base, embed, environment: async (model: { id: string }) => ({ ...(await base.environment({ id: model.id, revision: null })), model: { id: model.id, cached: false, revision: null, reason: "not cached" } }) };
    const outcome = await startOfflineRun(ctx.paths, caseId, { runner });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const run = await getRun(ctx.paths, caseId, outcome.runId);
    expect(["blocked", "failed", "partial"]).toContain(run!.summary.status);
    expect(run!.stages.find((s) => s.name === "shortlist")).toMatchObject({ state: "blocked", message: expect.stringContaining("nothing is downloaded automatically") });
    expect(embed).not.toHaveBeenCalled();
    const entries = run!.result ? [...run!.result.verified, ...run!.result.abstained, ...run!.result.unverified] : [];
    expect(entries.every((e) => e.retrieval.siglipRank === null && e.verification.designSimilarityIndex === null)).toBe(true);
  });
});

describe("intake route", () => {
  const post = (fields: Record<string, string | Blob>, init: Parameters<typeof localRequest>[1] = {}, id = caseId) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return intakePOST(localRequest(`/api/sourcing/intake/${id}`, { method: "POST", body: form, ...init }), { params: Promise.resolve({ caseId: id }) });
  };
  beforeEach(() => {
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
  });

  it("is local-only and same-origin, records a product with its photo, and serves the photo by id only", async () => {
    expect((await post({ action: "start" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ action: "start" }, { host: "10.0.0.2:3000" })).status).toBe(403);
    vi.stubEnv("NODE_ENV", "production");
    expect((await post({ action: "start" })).status).toBe(403);
    vi.stubEnv("NODE_ENV", "test");
    expect((await post({ action: "start" }, {}, "../etc")).status).toBe(400);

    const started = await (await post({ action: "start" })).json();
    const p = product(1);
    const fields = Object.fromEntries(Object.entries({ ...p, action: "save", intakeId: started.intakeId }).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const bad = await post({ ...fields, file: new File([new TextEncoder().encode("nope")], "x.png", { type: "image/png" }) });
    expect(bad.status).toBe(422);
    const ok = await post({ ...fields, file: new File([productImage(10).bytes as Uint8Array<ArrayBuffer>], "p.png", { type: "image/png" }) });
    expect(await ok.json()).toMatchObject({ ok: true, entryId: "p01" });

    const evidence = (path: string) => evidenceGET(localRequest(`/api/sourcing/evidence/${path}`, { origin: null }), { params: Promise.resolve({ parts: path.split("/") }) });
    const img = await evidence(`intake/${caseId}/${started.intakeId}/p01`);
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toBe("private, no-store");
    expect((await evidence(`intake/${caseId}/${started.intakeId}/p02`)).status).toBe(404);
    expect((await evidence(`intake/${caseId}/../../etc/passwd`)).status).toBe(400);
  });
});

// The genuine nesting-table reference, read-only, when this checkout has it (private data, not in the repository).
const GENUINE = "upl-2026-10-27t11-41-34z-a4adb99c";
describe.skipIf(!existsSync(join(repoRoot(), "evals/local/predictions", `${GENUINE}.json`)))("genuine uploaded reference (read-only)", () => {
  it("has a loadable fingerprint, a resolving photo and saved queries, and no candidates yet", async () => {
    const paths = localPaths(repoRoot());
    const saved = await loadSavedFingerprint(join(paths.predictions, `${GENUINE}.json`), GENUINE);
    expect(saved.fingerprint.source).toMatchObject({ kind: "model", dataSource: "live", modelId: "gpt-6-luna" });
    expect(saved.fingerprint.searchQueries.length).toBeGreaterThan(0);
    const ref = await getReference(paths, GENUINE);
    expect(ref?.photo.available).toBe(true);
    expect(ref?.understanding).toBe("furniture_identified");
    const state = await getIntakeState(paths, GENUINE);
    if (!state.collectionExists) expect(ref?.candidates.state).toBe("missing");
  });
});

describe("revisions of a saved product list", () => {
  /** A saved list of three products with no photos: the state of the first real intake. */
  async function savedWithoutPhotos() {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    for (const n of [1, 2, 3]) await saveEntry(ctx.paths, caseId, intakeId, product(n, n === 3 ? { supplierName: null, supplierProfileUrl: null, priceMin: null, priceMax: null, currency: null, priceUnit: null, moqQuantity: null, moqUnit: null } : {}), null);
    const done = await completeIntake(ctx.paths, caseId, intakeId);
    return { first: done.session, text: await readFile(publishedManifestPath(ctx.paths, caseId), "utf8") };
  }
  const sha = (t: string | Uint8Array) => createHash("sha256").update(t).digest("hex");
  const manifestNow = async () => candidateManifestSchema.parse(JSON.parse(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")));

  it("refuses a comparison when no product has a photo, and makes no run", async () => {
    await savedWithoutPhotos();
    const out = await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() });
    expect(out).toMatchObject({ ok: false, code: "not_eligible", message: "Add at least one product photo to compare its design with your furniture." });
    expect(await readdir(join(ctx.paths.sourcingRuns, caseId)).catch(() => [])).toEqual([]);
    expect(await readCollection(ctx.paths, caseId)).toMatchObject({ withPhoto: 0, revisable: true });
  });

  it("starts a revision pre-filled from the saved list, with an immutable snapshot, once (also when asked concurrently)", async () => {
    const { first, text } = await savedWithoutPhotos();
    const [a, b] = await Promise.all([startRevision(ctx.paths, caseId), startRevision(ctx.paths, caseId)]);
    expect(a.intakeId).toBe(b.intakeId);
    expect(a.basedOn).toMatchObject({ manifestSha256: sha(text), sourceIntakeId: first.intakeId });
    expect(a.entries.map((e) => [e.id, e.marketplaceProductId, e.listingUrl, e.title])).toEqual([1, 2, 3].map((n, i) => [`p0${i + 1}`, `10000000000${n}`, product(n).listingUrl, `[TEST] Nesting table ${n}`]));
    expect(a.entries[2]).toMatchObject({ supplierName: null, price: null, minimumOrder: null, image: null });
    expect(await readFile(join(ctx.paths.candidateIntake, caseId, a.basedOn!.snapshotFile), "utf8")).toBe(text);
    expect(await startRevision(ctx.paths, caseId)).toMatchObject({ intakeId: a.intakeId }); // reopens the draft
  });

  it("attaches photos to saved products, corrects a supplier, adds a product, and publishes a new version while keeping the old one", async () => {
    const { first, text } = await savedWithoutPhotos();
    const draft = await startRevision(ctx.paths, caseId);
    const id = draft.intakeId;
    await setEntryImage(ctx.paths, caseId, id, "p01", productImage(10));
    await setEntryImage(ctx.paths, caseId, id, "p02", productImage(20));
    expect(await problem(setEntryImage(ctx.paths, caseId, id, "p03", { bytes: new TextEncoder().encode("not a photo"), name: "x.png" }))).toBe("invalid_image:image");
    expect(await problem(setEntryImage(ctx.paths, caseId, id, "p09", productImage(30)))).toBe("unknown_entry");
    // Correct optional seller details of the product that had none; nothing else about it changes.
    const p3 = (await readSession(ctx.paths, caseId, id))!.entries[2];
    await saveEntry(ctx.paths, caseId, id, { entryId: "p03", listingUrl: p3.listingUrl, title: p3.title, supplierName: "[TEST] Supplier Three", supplierProfileUrl: "https://testsupplierthree.en.alibaba.com/", foundWith: p3.foundWith }, null);
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(2), null))).toBe("duplicate:listingUrl");
    await saveEntry(ctx.paths, caseId, id, product(4), productImage(40));
    const changes = await describeRevision(ctx.paths, (await readSession(ctx.paths, caseId, id))!);
    expect(changes).toEqual({ photosAdded: 2, photosReplaced: 0, productsAdded: 1, productsRemoved: 0, detailsChanged: 1, unchanged: 0 });

    const { session, summary } = await completeIntake(ctx.paths, caseId, id);
    expect(session).toMatchObject({ status: "completed", published: { previousManifestSha256: sha(text) } });
    expect(summary).toMatchObject({ products: 4, withImage: 3, withoutImage: ["[TEST] Nesting table 3"], previousManifestSha256: sha(text) });
    const m = await manifestNow();
    expect(m.candidates.map((c) => c.marketplaceProductId)).toEqual(["100000000001", "100000000002", "100000000003", "100000000004"]);
    expect(m.candidates.map((c) => c.listingUrl)).toEqual([1, 2, 3, 4].map((n) => product(n).listingUrl));
    expect(m.suppliers.map((s) => s.name)).toEqual(["[TEST] Supplier One", "[TEST] Supplier Three"]);
    expect(m.candidates[2]).toMatchObject({ price: null, minimumOrder: null, images: [] });
    const photo = m.candidates[0].images[0] as { localPath: string };
    expect(sha(await readFile(join(ctx.paths.candidates, photo.localPath)))).toBe(sha(productImage(10).bytes));
    // History: the first version's own copy and the snapshot are unchanged.
    expect(await readFile(join(ctx.paths.candidateIntake, caseId, first.intakeId, "manifest.json"), "utf8")).toBe(text);
    expect(await readFile(join(ctx.paths.candidateIntake, caseId, session.basedOn!.snapshotFile), "utf8")).toBe(text);
    expect(await readFile(join(ctx.paths.candidateIntake, caseId, id, "manifest.json"), "utf8")).toBe(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8"));
    expect(await problem(saveEntry(ctx.paths, caseId, id, product(5), null))).toBe("completed");
  });

  it("refuses to publish a stale revision, and lets only one of two simultaneous publishes through", async () => {
    await savedWithoutPhotos();
    const draft = await startRevision(ctx.paths, caseId);
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p01", productImage(10));
    const original = await readFile(publishedManifestPath(ctx.paths, caseId), "utf8");
    // The saved list changed after the revision began (another tool rewrote it).
    const changed = original.replace("[TEST] Nesting table 2", "[TEST] Nesting table 2 (edited elsewhere)");
    await writeFile(publishedManifestPath(ctx.paths, caseId), changed);
    expect(await problem(completeIntake(ctx.paths, caseId, draft.intakeId))).toBe("stale");
    expect(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")).toBe(changed);
    expect(await readdir(join(ctx.paths.candidates, caseId))).toEqual([]); // nothing published
    await writeFile(publishedManifestPath(ctx.paths, caseId), original);

    const results = await Promise.allSettled([completeIntake(ctx.paths, caseId, draft.intakeId), completeIntake(ctx.paths, caseId, draft.intakeId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as IntakeProblem).code).toBe("completed");
  });

  it("publishes atomically: a failure leaves the saved list and the candidate folder exactly as they were", async () => {
    const { text } = await savedWithoutPhotos();
    const draft = await startRevision(ctx.paths, caseId);
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p01", productImage(10));
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p02", productImage(20));
    // The second photo disappears from the draft before publishing.
    const p2 = (await readSession(ctx.paths, caseId, draft.intakeId))!.entries[1].image!.file;
    await rm(join(ctx.paths.candidateIntake, caseId, draft.intakeId, p2));
    expect(await problem(completeIntake(ctx.paths, caseId, draft.intakeId))).toBe("changed");
    expect(await readFile(publishedManifestPath(ctx.paths, caseId), "utf8")).toBe(text);
    expect(await readdir(join(ctx.paths.candidates, caseId))).toEqual([]);
    expect((await readSession(ctx.paths, caseId, draft.intakeId))?.status).toBe("draft");
    expect((await discardDraft(ctx.paths, caseId, draft.intakeId)).status).toBe("discarded");
    expect((await getIntakeState(ctx.paths, caseId)).draft).toBeNull();
  });

  it("keeps earlier runs readable, invalidates their shortlist when photos change, and never runs Sol", async () => {
    // Version 1: one product with a photo; compared locally.
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await saveEntry(ctx.paths, caseId, intakeId, product(2), null);
    await completeIntake(ctx.paths, caseId, intakeId);
    const siglip = fakeSiglip();
    const run1 = await startOfflineRun(ctx.paths, caseId, { runner: siglip });
    if (!run1.ok) throw new Error(run1.message);
    const before = (await getRun(ctx.paths, caseId, run1.runId))!.result!;
    expect(before.counts).toMatchObject({ withLocalImage: 1, shortlisted: 1 });
    const oldPhoto = (before.unverified.find((e) => e.imageEvidence.image)!.imageEvidence.image!).ref;
    // Keep that shortlist where `shortlist:images` saves reusable ones; with unchanged photos it is reused.
    const imported = importCuratedCandidates([await manifestNow()]);
    const savedShortlist = join(ctx.paths.shortlists, `${caseId}-siglip2-base-patch16-384${candidateSetTag(imported)}.json`);
    await mkdir(ctx.paths.shortlists, { recursive: true });
    await copyFile(join(ctx.paths.sourcingRuns, caseId, run1.runId, "shortlist.json"), savedShortlist);
    const reuse = await startOfflineRun(ctx.paths, caseId, { runner: siglip });
    if (!reuse.ok) throw new Error(reuse.message);
    expect((await getRun(ctx.paths, caseId, reuse.runId))!.stages.find((s) => s.name === "shortlist")?.state).toBe("reused");
    expect(siglip.requests).toHaveLength(1);

    // Version 2: replace product 1's photo and add product 2's.
    const draft = await startRevision(ctx.paths, caseId);
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p01", productImage(15));
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p02", productImage(25));
    expect(await describeRevision(ctx.paths, (await readSession(ctx.paths, caseId, draft.intakeId))!)).toMatchObject({ photosAdded: 1, photosReplaced: 1 });
    await completeIntake(ctx.paths, caseId, draft.intakeId);

    // The earlier run and its photo evidence are still readable.
    expect(existsSync(join(ctx.paths.candidates, oldPhoto))).toBe(true);
    expect((await getRun(ctx.paths, caseId, run1.runId))!.result).toEqual(before);
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
    const listing = before.unverified.find((e) => e.imageEvidence.image)!.listingId;
    const path = `candidate/${caseId}/${run1.runId}/${listing}`;
    const evidence = await evidenceGET(localRequest(`/api/sourcing/evidence/${path}`, { origin: null }), { params: Promise.resolve({ parts: path.split("/") }) });
    expect(evidence.status).toBe(200);

    // The saved shortlist no longer matches the photos: it is not reused, and the new photos are embedded.
    const run2 = await startOfflineRun(ctx.paths, caseId, { runner: siglip });
    if (!run2.ok) throw new Error(run2.message);
    const after = (await getRun(ctx.paths, caseId, run2.runId))!;
    expect(after.stages.find((s) => s.name === "shortlist")?.state).toBe("completed"); // recomputed, not "reused"
    expect(siglip.requests).toHaveLength(2);
    expect(siglip.requests[1].groups.flatMap((g) => g.images.map((i) => i.sha256)).sort()).toEqual([productImage(15), productImage(25)].map((p) => sha(p.bytes)).sort());
    expect(after.result!.counts).toMatchObject({ withLocalImage: 2, shortlisted: 2, verified: 0 });
    expect(await readdir(ctx.paths.verifications).catch(() => [] as string[])).not.toEqual(expect.arrayContaining([expect.stringContaining(caseId)]));
  });
});

// The genuine coffee-table collection, read-only: present, unchanged in shape, revisable, comparison refused.
describe.skipIf(!existsSync(join(repoRoot(), "evals/local/candidates", `${GENUINE}.json`)))("genuine coffee-table collection (read-only)", () => {
  it("keeps its three saved products and is ready for photos", async () => {
    const paths = localPaths(repoRoot());
    const before = await readFile(publishedManifestPath(paths, GENUINE), "utf8");
    const c = await readCollection(paths, GENUINE);
    expect(c?.products.map((p) => p.marketplaceProductId)).toEqual(expect.arrayContaining(["1601399634246", "1601610724636", "1601926230263"]));
    expect(c?.products.every((p) => p.listingUrl.startsWith("https://www.alibaba.com/product-detail/") && p.title.length > 0)).toBe(true);
    expect(c?.revisable).toBe(true);
    if (c?.withPhoto === 0) {
      // Refused before anything is written.
      expect(await startOfflineRun(paths, GENUINE, { runner: null })).toMatchObject({ ok: false, code: "not_eligible" });
    }
    const latest = (await getReference(paths, GENUINE))?.runs.find((r) => r.result.available);
    if (latest) expect((await getRun(paths, GENUINE, latest.runId))?.result).not.toBeNull();
    expect(await readFile(publishedManifestPath(paths, GENUINE), "utf8")).toBe(before);
  });
});
