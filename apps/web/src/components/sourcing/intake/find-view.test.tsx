import { join } from "node:path";
import { rm } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoveryReadiness } from "@/lib/sourcing/discovery/authorization";
import { referenceImageUrl } from "@/lib/sourcing/ui/data";
import { completeIntake, getIntakeState, saveEntry, startIntake } from "@/lib/sourcing/ui/intake/intake";
import { analysedUploadReference, product, productImage } from "@/lib/sourcing/ui/intake/test-fixtures";
import { describeRevision, readCollection, setEntryImage, startRevision } from "@/lib/sourcing/ui/intake/revision";
import { makeUiRepo } from "@/lib/sourcing/ui/test-fixtures";
import { loadSavedFingerprint } from "@/lib/sourcing/understanding/saved/saved-fingerprint";
import { EXA_PROVIDER_ID } from "@/lib/sourcing/discovery/providers/exa/exa-api";
import { exaResponse, exaResult, scriptedExa } from "@/lib/sourcing/discovery/providers/exa/test-fixtures";
import { makePng } from "@/lib/sourcing/verification/openai/test-fixtures";
import { listAutomaticSearches, startAutomaticSearch } from "@/lib/sourcing/ui/discovery/automatic-search";
import type { AutomaticSearchCard } from "./automatic-search-view";
import { FindView, type FindViewProps } from "./find-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
let queries: string[];

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  ({ caseId } = await analysedUploadReference(ctx.paths));
  queries = (await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId}.json`), caseId)).fingerprint.searchQueries;
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // rendering never searches or contacts anyone
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
function primary(html: string) {
  const inner = /<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/;
  while (inner.test(html)) html = html.replace(inner, "");
  return text(html);
}
const JARGON = /\b(manifest|provider API|fingerprint|embeddings?|SigLIP|model inference|orchestration|Sol)\b/i;

async function collectionProps() {
  const c = await readCollection(ctx.paths, caseId);
  return c ? { products: c.products, withPhoto: c.withPhoto, revisable: c.revisable } : null;
}

async function render(extra: Partial<FindViewProps> = {}) {
  const blocked = discoveryReadiness("image", { APIFY_TOKEN: "apify-test-present" }, { state: "missing" });
  vi.stubGlobal("fetch", fetchSpy);
  return renderToStaticMarkup(
    <FindView
      caseId={caseId}
      photoUrl={referenceImageUrl(caseId)}
      furnitureType="Chair · Dining chair"
      queries={queries}
      automatic={{ available: blocked.some((b) => b.eligible), reason: "No approved marketplace data source is set up, so products are added by hand for now." }}
      intake={await getIntakeState(ctx.paths, caseId)}
      collection={await collectionProps()}
      revisionChanges={null}
      latestRun={null}
      {...extra}
    />,
  );
}

describe("find similar products", () => {
  it("offers adding product leads, and shows automatic search as unavailable (not actionable)", async () => {
    const html = await render();
    const page = primary(html);
    expect(page).toContain("Ready to find similar products");
    expect(page).toContain("Add product leads");
    expect(page).toContain("Automatic marketplace search");
    expect(page).toContain("Not available yet.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Search automatically \(unavailable\)<\/button>/);
    expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>[^<]*Search automatically/);
    expect(html).toContain(`src="/api/sourcing/evidence/reference/${caseId}"`);
    expect(page).not.toMatch(JARGON);
  });

  it("during intake: the saved searches from the photo's analysis, a product form, and recorded products", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await saveEntry(ctx.paths, caseId, intakeId, product(2, { supplierName: null, supplierProfileUrl: null }), null);
    const html = await render();
    const page = primary(html);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(page).toContain(q);
    expect(page).toContain("Search Alibaba.com yourself");
    expect(html).toContain('href="https://www.alibaba.com/"');
    for (const label of ["Alibaba.com product link", "Product title", "Supplier name", "Minimum order", "Product photo", "Add this product"]) expect(page).toContain(label);
    expect(page).toContain("[TEST] Nesting table 1");
    expect(page).toContain("Ready to compare");
    expect(page).toContain("Photo needed");
    expect(page).toContain("Supplier not recorded");
    expect(html).toContain(`src="/api/sourcing/evidence/intake/${caseId}/${intakeId}/p01"`);
    expect(page).toContain("Finish: save 2 products");
    expect(page).not.toMatch(JARGON);
  });

  it("after intake: products saved, how many are ready, and the next step, with nothing presented as a match", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    await saveEntry(ctx.paths, caseId, intakeId, product(1), productImage(10));
    await saveEntry(ctx.paths, caseId, intakeId, product(2), null);
    await completeIntake(ctx.paths, caseId, intakeId);
    const before = primary(await render());
    expect(before).toContain("Products saved");
    expect(before).toContain("2 products saved · 1 ready to compare");
    expect(before).toContain("Compare available products");
    expect(before).toContain("Add missing product photos");
    expect(before).toMatch(/1 product with a photo will be compared\. 1 product without a photo will stay in the list, not compared\./);
    const after = primary(await render({ latestRun: { runId: "src-2026-10-27T12-00-00Z-abcdef", current: true, shortlisted: 1, compared: 0 } }));
    expect(after).toContain("View compared products");
    expect(after).toContain("Compared locally — detailed verification pending");
    expect(after).not.toMatch(/Closest design|Close design|\/100|match found/i);
    expect(after).not.toMatch(JARGON);
    const stale = primary(await render({ latestRun: { runId: "src-2026-10-27T12-00-00Z-abcdef", current: false, shortlisted: 1, compared: 0 } }));
    expect(stale).toContain("Compare available products");
    expect(stale).toContain("View earlier results");
  });

  it("a saved list with no photos offers adding photos, never a comparison", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    for (const n of [1, 2, 3]) await saveEntry(ctx.paths, caseId, intakeId, product(n), null);
    await completeIntake(ctx.paths, caseId, intakeId);
    const html = await render();
    const page = primary(html);
    expect(page).toContain("3 products saved · 0 ready to compare");
    expect(page).toContain("Add at least one product photo to compare its design with your furniture.");
    expect(page).toContain("Add product photos");
    expect(page).not.toMatch(/Compare with your photo|Compare available products|View compared products/);
    for (const n of [1, 2, 3]) expect(html).toContain(`href="${product(n).listingUrl}"`);
  });

  it("a revision shows each saved product with a photo action and the changes to save", async () => {
    const { intakeId } = await startIntake(ctx.paths, caseId);
    for (const n of [1, 2]) await saveEntry(ctx.paths, caseId, intakeId, product(n), null);
    await completeIntake(ctx.paths, caseId, intakeId);
    const draft = await startRevision(ctx.paths, caseId);
    await setEntryImage(ctx.paths, caseId, draft.intakeId, "p01", productImage(10));
    const state = await getIntakeState(ctx.paths, caseId);
    const page = primary(await render({ intake: state, revisionChanges: await describeRevision(ctx.paths, state.draft!) }));
    expect(page).toContain("Add missing product photos");
    expect(page).toContain("2 products · 1 ready to compare");
    expect(page).toContain("Replace photo");
    expect(page).toContain("Add photo");
    expect(page).toContain("Changes to save: 1 photo added.");
    expect(page).toContain("Save this version");
    expect(page).toContain("Discard this revision");
    expect(page).not.toMatch(JARGON);
  });

  it("when a source is eligible: a link to the confirmation step, never a direct search", async () => {
    const html = await render({ automatic: { available: true, reason: "", searches: [] } });
    expect(html).toContain(`href="/sourcing/find/${caseId}/search"`);
    expect(primary(html)).toContain("Search automatically");
    expect(primary(html)).toContain("You confirm before anything is sent.");
    expect(html).not.toMatch(/<button[^>]*>[^<]*Search automatically/);
  });
});

describe("saved automatic searches", () => {
  const eligible = async () => ({
    eligibility: { providerId: EXA_PROVIDER_ID, mode: "keyword" as const, eligible: true, checks: [], blocker: null, limits: { maxResults: 20, maxCostUsd: 0.5 } },
    access: { state: "ok" as const, record: { schemaVersion: 1 as const, providers: { [EXA_PROVIDER_ID]: { accessBasis: "search_index_terms_review" as const, agreementReference: "[TEST]", reviewedBy: "t", reviewedAt: "2026-11-03", permittedModes: ["keyword" as const], imageTransferApproved: false, liveEnabled: true, maxResultsPerRun: 20, maxCostUsdPerRun: 0.5, productImageRetrievalApproved: images } } } },
  });
  let images = false;

  async function cards(): Promise<AutomaticSearchCard[]> {
    return (await listAutomaticSearches(ctx.paths, caseId)).map((s) => ({
      discoveryId: s.discoveryId,
      createdAt: s.createdAt,
      status: s.status,
      unfinished: s.unfinished,
      meaning: s.meaning,
      summary: s.summary,
      products: s.products.map((p, i) => ({ title: p.title, listingUrl: p.listingUrl, imageUrl: p.localImage ? `/api/sourcing/evidence/discovery/${caseId}/${s.discoveryId}/${i}` : null, price: p.price ?? null, minimumOrder: p.minimumOrder ?? null })),
      run: null,
    }));
  }
  async function search(script: Parameters<typeof scriptedExa>[0]) {
    const exa = scriptedExa(script);
    await startAutomaticSearch(ctx.paths, caseId, { requestKey: crypto.randomUUID(), confirmed: true }, {
      env: { EXA_API_KEY: "exa-test" },
      fetch: exa.fetch,
      checkAccess: eligible,
      fetchImage: async (url) => ({ url, contentType: "image/png", bytes: new Uint8Array(makePng(40, 30, 33)) }),
      convertAvif: null,
    });
  }
  const ok = (...ns: number[]) => () => ({ status: 200, json: exaResponse(ns.map((n) => exaResult(n))) });

  it("found products with photos: real stages, honest provenance, and a comparison offer — nothing called a match", async () => {
    images = true;
    await search([ok(1, 2), ok(), ok(), ok()]);
    const html = await render({ automatic: { available: true, reason: "", searches: await cards() } });
    const page = primary(html);
    expect(page).toContain("Found by automatic search");
    expect(page).toMatch(/Done · Searching products/);
    expect(page).toMatch(/Done · Reviewing returned listings/);
    expect(page).toMatch(/Done · Preparing product photographs/);
    expect(page).toMatch(/Next · Comparing available images/);
    expect(page).toMatch(/Not yet · Detailed verification/);
    expect(page).toContain("not by Alibaba.com");
    expect(page).toContain("2 products found · 2 with a photo");
    expect(page).toContain("supplier not reported by this source");
    expect(page).toContain("Found automatically");
    expect(page).toContain("as indexed, may be out of date");
    expect(page).toContain("Compare these products with your photo");
    expect(page).not.toMatch(/Closest design|match found|verified match|\/100/i);
    expect(page).not.toMatch(JARGON);
    images = false;
  });

  it("found products without permitted photos: kept as leads, comparison not offered", async () => {
    await search([ok(1), ok(), ok(), ok()]);
    const page = primary(await render({ automatic: { available: false, reason: "No approved marketplace data source is set up, so products are added by hand for now.", searches: await cards() } }));
    expect(page).toMatch(/Waiting · Preparing product photographs/);
    expect(page).toContain("Photos needed before comparing");
    expect(page).toContain("Photo needed");
    expect(page).not.toMatch(/Compare these products|Compare products that have a photo/);
  });

  it("a failed search is shown as failed, not as zero results", async () => {
    await search([() => ({ status: 402, json: { error: "payment required" } })]);
    const page = primary(await render({ automatic: { available: true, reason: "", searches: await cards() } }));
    expect(page).toMatch(/Failed · Searching products/);
    expect(page).toContain("not an empty result");
    expect(page).not.toContain("products found");
  });
});
