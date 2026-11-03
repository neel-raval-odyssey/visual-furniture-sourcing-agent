import type { FetchLike } from "./exa-api";

/**
 * TEST-ONLY synthetic Exa search results. Product ids are 13-digit numbers no
 * real listing is known to use ("1000000000NNN"); titles carry a [TEST] marker.
 */
export const testListingUrl = (n: number, host = "www.alibaba.com") => `https://${host}/product-detail/TEST-Pebble-Nesting-Coffee-Table-${n}_1000000000${String(n).padStart(3, "0")}.html`;
export const testImageUrl = (n: number) => `https://s.alicdn.com/@sc04/kf/TEST-${n}.jpg`;

export const exaResult = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `https://www.alibaba.com/product-detail/x_${n}`,
  url: `${testListingUrl(n)}?spm=a2700.test`,
  title: `[TEST] Pebble nesting coffee table set ${n}`,
  publishedDate: null,
  author: null,
  image: testImageUrl(n),
  highlights: [`Wooden nesting coffee table. US$45.00-52.00 / piece. Min. order: 2 pieces`],
  ...extra,
});

export const exaResponse = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  requestId: `req_test_${Math.random().toString(16).slice(2, 10)}`,
  results,
  costDollars: { total: 0.017 },
  searchTime: 120,
  ...extra,
});

/** A fake transport: answers each request with the next scripted response (or throws it). Records request bodies. */
type Scripted = { status: number; json?: unknown; text?: string };
export function scriptedExa(script: ((body: Record<string, unknown>) => Scripted | Error | Promise<Scripted | Error>)[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, headers: init.headers, body });
    const step = script[calls.length - 1];
    if (!step) throw new Error(`unexpected request ${calls.length}`);
    const out = await step(body);
    if (out instanceof Error) throw out;
    return { status: out.status, text: async () => out.text ?? JSON.stringify(out.json) };
  };
  return { fetch, calls };
}
