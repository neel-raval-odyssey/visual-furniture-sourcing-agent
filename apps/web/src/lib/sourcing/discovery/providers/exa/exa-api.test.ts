import { describe, expect, it } from "vitest";
import { buildSearchBody, estimateSearchCostUsd, EXA_SEARCH_ENDPOINT, ExaError, exaSearch, isUncertainOutcome, type FetchLike } from "./exa-api";
import { exaResponse, exaResult, scriptedExa } from "./test-fixtures";

const KEY = "exa-test-key-never-real";

describe("Exa search request", () => {
  it("sends only documented fields: the query text, never a photo, restricted to Alibaba.com product pages", () => {
    const body = buildSearchBody("  organic pebble nesting coffee tables  ", 10);
    expect(body).toEqual({
      query: "organic pebble nesting coffee tables",
      type: "auto",
      numResults: 10,
      includeDomains: ["www.alibaba.com/product-detail"],
      contents: { highlights: { query: "price per piece and minimum order quantity", maxCharacters: 600 } },
    });
    expect(JSON.stringify(body)).not.toMatch(/image|base64|data:/i);
  });

  it("refuses empty queries and out-of-budget result counts", () => {
    expect(() => buildSearchBody(" ", 10)).toThrow(RangeError);
    expect(() => buildSearchBody("table", 0)).toThrow(RangeError);
    expect(() => buildSearchBody("table", 11)).toThrow(RangeError);
  });

  it("estimates cost from published prices (search + highlights per page)", () => {
    expect(estimateSearchCostUsd(10)).toBe(0.017);
    expect(estimateSearchCostUsd(1)).toBe(0.008);
  });

  it("POSTs JSON to the documented endpoint with the key only in x-api-key", async () => {
    const exa = scriptedExa([() => ({ status: 200, json: exaResponse([exaResult(1)]) })]);
    const out = await exaSearch(buildSearchBody("pebble table", 5), { apiKey: KEY, fetch: exa.fetch });
    expect(out.results).toHaveLength(1);
    expect(exa.calls[0].url).toBe(EXA_SEARCH_ENDPOINT);
    expect(exa.calls[0].headers["x-api-key"]).toBe(KEY);
    expect(JSON.stringify(exa.calls[0].body)).not.toContain(KEY);
  });
});

describe("Exa errors", () => {
  const fail = async (status: number, json: unknown = { error: "nope" }) => {
    const exa = scriptedExa([() => ({ status, json })]);
    return exaSearch(buildSearchBody("q", 3), { apiKey: KEY, fetch: exa.fetch }).catch((e: ExaError) => e);
  };

  it("missing credentials fail before any request", async () => {
    const exa = scriptedExa([]);
    const e = await exaSearch(buildSearchBody("q", 3), { apiKey: " ", fetch: exa.fetch }).catch((x: ExaError) => x);
    expect(e).toBeInstanceOf(ExaError);
    expect((e as ExaError).category).toBe("authentication");
    expect(exa.calls).toHaveLength(0);
  });

  it.each([
    [400, "bad_request"],
    [401, "authentication"],
    [402, "payment_required"],
    [403, "permission"],
    [429, "rate_limit"],
    [503, "server_error"],
  ])("HTTP %i → %s, never uncertain", async (status, category) => {
    const e = (await fail(status)) as ExaError;
    expect(e.category).toBe(category);
    expect(isUncertainOutcome(e)).toBe(false);
  });

  it("never echoes the key from an error body", async () => {
    const e = (await fail(401, { error: `invalid key ${KEY}` })) as ExaError;
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("[redacted]");
  });

  it("a timeout or network failure is an uncertain outcome (the request may have been billed)", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const timeout = (await exaSearch(buildSearchBody("q", 3), { apiKey: KEY, fetch: hang, timeoutMs: 5 }).catch((x: ExaError) => x)) as ExaError;
    expect(timeout.category).toBe("timeout");
    expect(isUncertainOutcome(timeout)).toBe(true);
    const net = scriptedExa([() => new TypeError("fetch failed")]);
    const network = (await exaSearch(buildSearchBody("q", 3), { apiKey: KEY, fetch: net.fetch }).catch((x: ExaError) => x)) as ExaError;
    expect(network.category).toBe("network");
    expect(isUncertainOutcome(network)).toBe(true);
  });

  it("an answer without a results array is invalid, never an empty result", async () => {
    const e = (await (async () => {
      const exa = scriptedExa([() => ({ status: 200, json: { data: [] } })]);
      return exaSearch(buildSearchBody("q", 3), { apiKey: KEY, fetch: exa.fetch }).catch((x: ExaError) => x);
    })()) as ExaError;
    expect(e.category).toBe("invalid_response");
    const notJson = scriptedExa([() => ({ status: 200, text: "<html>" })]);
    expect(((await exaSearch(buildSearchBody("q", 3), { apiKey: KEY, fetch: notJson.fetch }).catch((x: ExaError) => x)) as ExaError).category).toBe("invalid_response");
  });
});
