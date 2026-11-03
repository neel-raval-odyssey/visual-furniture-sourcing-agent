import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEligibility } from "../discovery/authorization";
import { EXA_PROVIDER_ID } from "../discovery/providers/exa/exa-api";
import { exaResponse, exaResult, scriptedExa } from "../discovery/providers/exa/test-fixtures";
import { analysedUploadReference } from "../ui/intake/test-fixtures";
import { makeUiRepo } from "../ui/test-fixtures";
import { PRODUCTS_EXIT_BLOCKED, PRODUCTS_EXIT_OK, PRODUCTS_EXIT_USAGE, runDiscoverProductsCli, type DiscoverProductsCliDeps } from "./discover-products";

const globalFetch = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let caseId: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  ({ caseId } = await analysedUploadReference(ctx.paths));
  out = [];
  err = [];
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(async () => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

const cli = (argv: string[], extra: Partial<DiscoverProductsCliDeps> = {}) =>
  runDiscoverProductsCli(argv, { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, repoRoot: ctx.root, env: { EXA_API_KEY: "exa-test-key" }, ...extra });

const eligibleForTests: DiscoverProductsCliDeps["checkAccess"] = async () => ({
  eligibility: { providerId: EXA_PROVIDER_ID, mode: "keyword", eligible: true, checks: [], blocker: null, limits: { maxResults: 20, maxCostUsd: 0.5 } } satisfies SourceEligibility,
  access: { state: "missing" },
});

describe("discover:products", () => {
  it("dry run (the default) prints the plan, the blocked checks and the exact bodies, and sends nothing", async () => {
    const exa = scriptedExa([]);
    expect(await cli(["--case", caseId], { fetch: exa.fetch })).toBe(PRODUCTS_EXIT_OK);
    const text = out.join("\n");
    expect(text).toContain("DRY RUN — nothing is sent.");
    expect(text).toContain("[BLOCKED] policy:");
    expect(text).toMatch(/Live search: BLOCKED/);
    expect(text).toContain('"includeDomains":["www.alibaba.com/product-detail"]');
    expect(text).not.toContain("exa-test-key");
    expect(exa.calls).toHaveLength(0);
  });

  it("--live needs --confirm-paid-search, and is blocked by the real gate", async () => {
    const exa = scriptedExa([]);
    expect(await cli(["--case", caseId, "--live"], { fetch: exa.fetch })).toBe(PRODUCTS_EXIT_USAGE);
    expect(await cli(["--case", caseId, "--live", "--confirm-paid-search"], { fetch: exa.fetch })).toBe(PRODUCTS_EXIT_BLOCKED);
    expect(err.join("\n")).toMatch(/Live search blocked: .*external web search index/);
    expect(exa.calls).toHaveLength(0);
  });

  it("with an eligible source (test double) it searches once per saved query and reports the saved run; --status lists it", async () => {
    const exa = scriptedExa([1, 2, 3, 4].map((n) => () => ({ status: 200, json: exaResponse([exaResult(n)]) })));
    expect(await cli(["--case", caseId, "--live", "--confirm-paid-search"], { fetch: exa.fetch, checkAccess: eligibleForTests })).toBe(PRODUCTS_EXIT_OK);
    expect(exa.calls).toHaveLength(4);
    expect(out.join("\n")).toMatch(/Automatic search disc-.*: completed\./);
    out = [];
    expect(await cli(["--case", caseId, "--status"])).toBe(PRODUCTS_EXIT_OK);
    expect(out.join("\n")).toMatch(/4 returned, 4 Alibaba product links, 4 unique products, 0 with a local photo, \$0\.068 reported/);
  });

  it("rejects bad arguments", async () => {
    expect(await cli([])).toBe(PRODUCTS_EXIT_USAGE);
    expect(await cli(["--case", caseId, "--status", "--dry-run"])).toBe(PRODUCTS_EXIT_USAGE);
    expect(await cli(["--case", caseId, "--fetch-images", "disc-nope"])).toBe(PRODUCTS_EXIT_USAGE);
  });
});
