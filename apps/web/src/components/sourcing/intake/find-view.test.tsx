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
});
