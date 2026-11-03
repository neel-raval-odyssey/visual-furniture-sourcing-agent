import { rm } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXA_PROVIDER_ID } from "@/lib/sourcing/discovery/providers/exa/exa-api";
import { exaResponse, exaResult, scriptedExa, testImageUrl } from "@/lib/sourcing/discovery/providers/exa/test-fixtures";
import { getRun } from "@/lib/sourcing/ui/data";
import { startAutomaticSearch } from "@/lib/sourcing/ui/discovery/automatic-search";
import { analysedUploadReference, fakeSiglip } from "@/lib/sourcing/ui/intake/test-fixtures";
import { startOfflineRun } from "@/lib/sourcing/ui/offline-run";
import { makeUiRepo } from "@/lib/sourcing/ui/test-fixtures";
import { makePng } from "@/lib/sourcing/verification/openai/test-fixtures";
import { SimpleResultsView } from "./results";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const globalFetch = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  ({ caseId } = await analysedUploadReference(ctx.paths));
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(async () => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("results of an automatic search compared locally", () => {
  it("are potentially similar, pending detailed verification, with their source stated and products without photos kept apart", async () => {
    const exa = scriptedExa([() => ({ status: 200, json: exaResponse([exaResult(1), exaResult(2), exaResult(3)]) }), ...[1, 2, 3].map(() => () => ({ status: 200, json: exaResponse([]) }))]);
    const search = await startAutomaticSearch(ctx.paths, caseId, { requestKey: crypto.randomUUID(), confirmed: true }, {
      env: { EXA_API_KEY: "exa-test" },
      fetch: exa.fetch,
      convertAvif: null,
      fetchImage: async (url) => (url === testImageUrl(3) ? Promise.reject(new Error("http_error: 404")) : { url, contentType: "image/png", bytes: new Uint8Array(makePng(40, 30, url.length)) }),
      checkAccess: async () => ({
        eligibility: { providerId: EXA_PROVIDER_ID, mode: "keyword", eligible: true, checks: [], blocker: null, limits: { maxResults: 20, maxCostUsd: 0.5 } },
        access: { state: "ok", record: { schemaVersion: 1, providers: { [EXA_PROVIDER_ID]: { accessBasis: "search_index_terms_review", agreementReference: "[TEST]", reviewedBy: "t", reviewedAt: "2026-11-03", permittedModes: ["keyword"], imageTransferApproved: false, liveEnabled: true, maxResultsPerRun: 20, maxCostUsdPerRun: 0.5, productImageRetrievalApproved: true } } } },
      }),
    });
    const run = await startOfflineRun(ctx.paths, caseId, { runner: fakeSiglip() }, { kind: "automatic", discoveryId: search.ok ? search.discoveryId : "" });
    const runId = run.ok ? run.runId : "";
    const page = text(renderToStaticMarkup(<SimpleResultsView caseId={caseId} runId={runId} result={(await getRun(ctx.paths, caseId, runId))!.result} />));
    expect(page).toContain("Potentially similar products — detailed verification pending.");
    expect(page).toContain("found automatically through a web search index limited to Alibaba.com product pages");
    expect(page).toContain("Compared locally");
    expect(page).toContain("Photo needed");
    expect(page).not.toMatch(/Closest design|verified match|\/100|Live marketplace search is not yet available/);
  });
});
