import { describe, expect, it, vi } from "vitest";
import { buildImageSearchInput, buildKeywordInput, estimateRunCostUsd, planDiscovery } from "./actor-input";
import { ApifyClient, ApifyError, type FetchLike } from "./apify-client";

const TOKEN = "apify_api_TESTTOKEN_not_real";
const runBody = (status = "RUNNING") => ({ data: { id: "RunTest00000000001", status, defaultDatasetId: "DatasetTest0000001", startedAt: "2026-10-27T10:00:00.000Z", usageTotalUsd: 0 } });

function client(respond: (url: string, init: Parameters<FetchLike>[1]) => Response | Promise<Response>) {
  const fetch = vi.fn<FetchLike>(async (url, init) => respond(url, init));
  return { fetch, api: new ApifyClient({ token: TOKEN, fetch, baseUrl: "https://api.apify.example/v2" }) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ApifyClient", () => {
  it("starts a run with bearer auth, cost and size caps, and no token in the URL", async () => {
    const { fetch, api } = client(() => json(runBody(), 201));
    const run = await api.startRun("scrapewise/alibaba-com-scraper", { keywords: ["x"] }, { timeoutSecs: 300, maxTotalChargeUsd: 0.5, maxItems: 10 });
    expect(run).toMatchObject({ id: "RunTest00000000001", status: "RUNNING", datasetId: "DatasetTest0000001" });
    const [url, init] = fetch.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/v2/acts/scrapewise~alibaba-com-scraper/runs");
    expect(Object.fromEntries(u.searchParams)).toEqual({ timeout: "300", maxTotalChargeUsd: "0.5", maxItems: "10" });
    expect(url).not.toContain(TOKEN);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ keywords: ["x"] });
    expect(init.method).toBe("POST");
  });

  it("maps provider errors to categories without leaking the token", async () => {
    const cases: [number, string][] = [
      [401, "authentication"],
      [402, "payment_required"],
      [403, "permission"],
      [404, "not_found"],
      [429, "rate_limit"],
      [500, "server_error"],
      [400, "bad_request"],
    ];
    for (const [status, category] of cases) {
      const { api } = client(() => json({ error: { type: "x", message: `echo ${TOKEN}`.replace(TOKEN, "redacted") } }, status));
      const error = await api.getRun("RunTest00000000001").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApifyError);
      expect((error as ApifyError).category).toBe(category);
      expect((error as ApifyError).message).not.toContain(TOKEN);
    }
  });

  it("reports timeouts and network failures, and never retries a start", async () => {
    const timeout = client(() => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(timeout.api.startRun("scrapewise/alibaba-com-scraper", {}, { timeoutSecs: 300, maxTotalChargeUsd: 1, maxItems: 1 })).rejects.toMatchObject({ category: "timeout" });
    expect(timeout.fetch).toHaveBeenCalledTimes(1);
    const down = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(down.api.getRun("RunTest00000000001")).rejects.toMatchObject({ category: "network" });
  });

  it("validates run and dataset responses", async () => {
    await expect(client(() => json({ data: { id: "x" } })).api.getRun("RunTest00000000001")).rejects.toMatchObject({ category: "malformed_response" });
    await expect(client(() => json({ items: [] })).api.getDatasetItems("DatasetTest0000001", 10)).rejects.toMatchObject({ category: "malformed_response" });
    const ok = client(() => json([{ type: "product" }]));
    expect(await ok.api.getDatasetItems("DatasetTest0000001", 10)).toEqual([{ type: "product" }]);
    expect(Object.fromEntries(new URL(ok.fetch.mock.calls[0][0]).searchParams)).toEqual({ format: "json", clean: "true", limit: "10" });
    await expect(ok.api.getRun("../../users/me")).rejects.toMatchObject({ category: "bad_request" });
    const wait = client(() => json(runBody("SUCCEEDED")));
    await wait.api.getRun("RunTest00000000001", 90);
    expect(new URL(wait.fetch.mock.calls[0][0]).searchParams.get("waitForFinish")).toBe("60");
  });

  it("refuses to be created without a token", () => {
    expect(() => new ApifyClient({ token: "" })).toThrow(ApifyError);
  });
});

describe("Actor input and budget", () => {
  it("builds image-search payloads for each transport", () => {
    expect(buildImageSearchInput({ kind: "url", url: "https://photos.example/ref.png" }, 10)).toEqual({
      searchType: "products",
      includeDetails: false,
      maxItems: 10,
      maxResultsPerImage: 10,
      imageUrls: ["https://photos.example/ref.png"],
    });
    expect(buildImageSearchInput({ kind: "apify_storage", url: "https://api.apify.com/v2/key-value-stores/s/records/k" }, 5)).toMatchObject({
      imageFile: "https://api.apify.com/v2/key-value-stores/s/records/k",
    });
  });

  it("builds keyword payloads with a per-query cap", () => {
    expect(buildKeywordInput(["a", "b", "c"], 10)).toEqual({ searchType: "products", includeDetails: false, keywords: ["a", "b", "c"], maxItems: 10, maxItemsPerKeyword: 4 });
    expect(() => buildKeywordInput([], 10)).toThrow();
  });

  it("budgets hybrid mode as two separately capped runs", () => {
    expect(estimateRunCostUsd("image", 10)).toBe(0.004);
    expect(estimateRunCostUsd("image", 70)).toBe(0.014);
    expect(estimateRunCostUsd("keyword", 20)).toBe(0.02);
    const plan = planDiscovery({ mode: "hybrid", maxResults: 10, fingerprintQueries: ["q1", "q2", "q3", "q4"], maxQueries: 2, costCapUsd: 1 });
    expect(plan.runs.map((r) => [r.mode, r.costCapUsd, r.queries])).toEqual([
      ["image", 0.5, []],
      ["keyword", 0.5, ["q1", "q2"]],
    ]);
    const tight = planDiscovery({ mode: "hybrid", maxResults: 50, fingerprintQueries: ["q"], maxQueries: 1, costCapUsd: 0.05 });
    expect(tight.problems.join(" ")).toMatch(/keyword run may cost up to \$0.05 but its share of the cap is \$0.025/);
    expect(planDiscovery({ mode: "keyword", maxResults: 5, fingerprintQueries: [], maxQueries: 2, costCapUsd: 1 }).problems[0]).toMatch(/no search queries/);
  });
});
