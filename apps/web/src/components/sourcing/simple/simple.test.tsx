import { existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SourcingResult } from "@/lib/sourcing/orchestration/assemble";
import { LISTING_A, LISTING_C } from "@/lib/sourcing/orchestration/test-fixtures";
import { getRun } from "@/lib/sourcing/ui/data";
import { localPaths, repoRoot } from "@/lib/sourcing/ui/local-access";
import { compareHref, getFeaturedExample, keyDifference, plainVerdict, resultsHref, shortTitle, splitResults, type FeaturedExample } from "@/lib/sourcing/ui/simple";
import { makeUiRepo } from "@/lib/sourcing/ui/test-fixtures";
import { SimpleCompareView } from "./compare";
import { SimpleResultsView } from "./results";
import { SimpleStart } from "./start";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let result: SourcingResult;
let example: FeaturedExample;

beforeAll(async () => {
  ctx = await makeUiRepo();
  result = (await getRun(ctx.paths, ctx.caseId, ctx.runId!))!.result!;
  example = (await getFeaturedExample(ctx.paths))!;
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // rendering never makes a request
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await rm(ctx.root, { recursive: true, force: true });
});

const render = (node: React.ReactElement) => {
  vi.stubGlobal("fetch", fetchSpy);
  return renderToStaticMarkup(node);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
/** The page as seen before opening any disclosure (innermost <details> removed first). */
function primary(html: string) {
  const inner = /<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/;
  while (inner.test(html)) html = html.replace(inner, "");
  return text(html);
}
const TECHNICAL = /\b(SigLIP|cosine|Luna|Sol|GPT|embedding|fingerprint|provider|orchestrat\w*|journal|tokens?|checkpoint|operator)\b/i;

describe("simple start screen", () => {
  it("features the saved reference and links to its saved run", () => {
    expect(example).toMatchObject({ caseId: ctx.caseId, runId: ctx.runId, photoUrl: `/api/sourcing/evidence/reference/${ctx.caseId}`, synthetic: false, candidates: 4, compared: 2 });
    const html = render(<SimpleStart example={example} />);
    expect(text(html)).toContain("Find furniture that looks like this.");
    expect(html).toContain(`src="/api/sourcing/evidence/reference/${ctx.caseId}"`);
    expect(html).toContain(`href="${resultsHref(ctx.caseId, ctx.runId!)}"`);
    expect(text(html)).toContain("Explore example results");
    expect(text(html)).toContain("This example uses saved Alibaba listings. Live marketplace search is not yet available.");
    expect(text(html)).toMatch(/saves your photo privately on this computer\. You can then ask AI to analyze/);
    expect(text(html)).toMatch(/Searching for similar products isn't available for new photos yet/);
    expect(text(html)).not.toMatch(/find suppliers/i);
    expect(primary(html)).not.toMatch(TECHNICAL);
  });

  it("says so truthfully when no saved example exists", async () => {
    const empty = await makeUiRepo({ run: false });
    try {
      expect(await getFeaturedExample(empty.paths)).toBeNull();
    } finally {
      await rm(empty.root, { recursive: true, force: true });
    }
    const html = text(render(<SimpleStart example={null} />));
    expect(html).toContain("No saved example is available yet");
    expect(html).not.toContain("Explore example results");
    expect(html).toContain("Try your own furniture photo");
  });
});

describe("simple results", () => {
  const html = () => render(<SimpleResultsView caseId={ctx.caseId} runId={ctx.runId!} result={result} />);

  it("shows the closest design first, in the saved verification order, without technical terms", () => {
    const page = primary(html());
    expect(page).toContain("Similar furniture we found");
    expect(page).toContain("Closest design found");
    expect(page).toContain("Close design"); // close_variant, never "exact"
    expect(page).not.toMatch(/exact/i);
    expect(page).not.toMatch(/\d+\s*\/\s*100|\b79\b|\b55\b|%/);
    expect(page).not.toMatch(TECHNICAL);
    const positions = result.verified.map((e) => html().indexOf(`href="${compareHref(ctx.caseId, ctx.runId!, e.listingId)}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const e of [...result.verified, ...result.unverified]) expect(html()).toContain(`href="${e.listingUrl}"`);
  });

  it("explains the major structural difference from the saved evidence", () => {
    const page = primary(html());
    const at = page.indexOf("Most important difference");
    expect(at).toBeGreaterThan(0);
    expect(page.slice(at, at + 200)).toMatch(/Headboard Arch Count .*Original: \[TEST\] seven narrow arches This design: \[TEST\] six narrow arches/);
    expect(keyDifference(result.verified[0].verification)).toMatchObject({ kind: "partial", original: "[TEST] seven narrow arches" });
  });

  it("keeps unverified products separate and unscored, and the scores behind a disclosure", () => {
    const { notCompared } = splitResults(result);
    expect(notCompared.map((e) => e.listingId)).toContain(LISTING_C);
    for (const e of notCompared) expect(plainVerdict(e)).toMatchObject({ label: "Not yet compared", compared: false });
    const page = primary(html());
    expect(page).toContain("Not yet compared");
    expect(page).toContain("Only a link to the listing photo was saved");
    const full = text(html());
    expect(full).toContain("Technical details");
    expect(full).toContain("79/100");
    expect(full).toMatch(/not a probability/);
  });

  it("shows a truthful empty state without a result", () => {
    const page = text(render(<SimpleResultsView caseId={ctx.caseId} runId={ctx.runId!} result={null} />));
    expect(page).toContain("No saved results for this photo yet");
    expect(page).not.toContain("Closest design found");
  });
});

describe("simple comparison", () => {
  const view = (listingId: string) =>
    render(<SimpleCompareView caseId={ctx.caseId} runId={ctx.runId!} result={result} entry={[...result.verified, ...result.unverified].find((e) => e.listingId === listingId)!} />);

  it("shows both photos, a plain verdict, similarities and differences, with detail behind disclosures", () => {
    const html = view(LISTING_A);
    const page = primary(html);
    expect(html).toContain(`src="/api/sourcing/evidence/reference/${ctx.caseId}"`);
    expect(html).toContain(`src="/api/sourcing/evidence/candidate/${ctx.caseId}/${ctx.runId}/${LISTING_A}"`);
    expect(html).toContain("object-contain");
    for (const s of ["Original", "This design", "Close design", "What looks similar", "What's different", "View on Alibaba", "Back to results", "Next"]) expect(page).toContain(s);
    expect(page).toContain("[TEST] six narrow arches");
    expect(page).not.toMatch(TECHNICAL);
    expect(page).not.toMatch(/\d+\s*\/\s*100/);
    expect(html).toContain(`href="${result.verified[0].listingUrl}"`);
    const full = text(html);
    expect(full).toContain("See detailed comparison");
    expect(full).toContain("Partial structural differences (1)");
    expect(full).toContain("Product and supplier details");
    expect(full).toContain("Marketplace-reported information");
  });

  it("does not invent a comparison for a product without one", () => {
    const page = primary(view(LISTING_C));
    expect(page).toContain("Not yet compared");
    expect(page).not.toContain("What looks similar");
    expect(page).not.toMatch(/\d+\s*\/\s*100/);
  });
});

describe("display helpers", () => {
  it("shortens long marketplace titles at a natural break", () => {
    expect(shortTitle("Classic French Vintage Solid Wood Platform Bed with Arched Headboard Mid-Century Wooden Bedroom Furniture")).toBe("Classic French Vintage Solid Wood Platform Bed");
    expect(shortTitle("Wooden king Size Bed Frame Bed Solid Wood Queen Size Wooden Bed Frame Solid Wood Queen Bed")).toMatch(/^Wooden king Size Bed Frame Bed Solid Wood.*…$/);
    expect(shortTitle("Oak bed")).toBe("Oak bed");
  });
});

// Genuine saved records, read-only, when this checkout has them (they are private and not in the repository).
const genuine = join(repoRoot(), "evals/local/sourcing-runs/ettrick-bed");
describe.skipIf(!existsSync(genuine))("genuine Ettrick example (read-only)", () => {
  it("is the featured example, with four Alibaba products in saved order and no exact-match claim", async () => {
    const paths = localPaths(repoRoot());
    const featured = await getFeaturedExample(paths);
    expect(featured).toMatchObject({ caseId: "ettrick-bed", synthetic: false });
    const real = (await getRun(paths, featured!.caseId, featured!.runId))!.result!;
    expect(real.verified).toHaveLength(4);
    const indices = real.verified.map((e) => e.verification.designSimilarityIndex!);
    expect([...indices].sort((a, b) => b - a)).toEqual(indices);
    const page = primary(render(<SimpleResultsView caseId={featured!.caseId} runId={featured!.runId} result={real} />));
    expect(page).not.toMatch(/exact|identical|verified supplier|same manufacturer/i);
    expect(page).toContain(keyDifference(real.verified[0].verification)!.candidate!);
  });
});
