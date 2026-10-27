import type dns from "node:dns";
import { describe, expect, it, vi } from "vitest";
import {
  checkImageUrl,
  DEFAULT_IMAGE_FETCH_POLICY,
  ImageFetchError,
  isPublicAddress,
  makeSafeLookup,
  safeFetchImage,
  type HttpGet,
} from "./safe-image-fetch";

const policy = DEFAULT_IMAGE_FETCH_POLICY;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function codeOf(p: Promise<unknown> | (() => unknown)) {
  const error = await (typeof p === "function" ? Promise.resolve().then(p) : p).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ImageFetchError);
  return (error as ImageFetchError).code;
}

describe("address and URL checks", () => {
  it("allows only public unicast addresses", () => {
    for (const ip of ["8.8.8.8", "47.246.1.1", "2606:4700::1111"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it("accepts https URLs on allowlisted hosts only", async () => {
    expect(checkImageUrl("https://s.alicdn.com/kf/x.jpg", policy).hostname).toBe("s.alicdn.com");
    expect(await codeOf(() => checkImageUrl("http://s.alicdn.com/x.jpg", policy))).toBe("invalid_url");
    expect(await codeOf(() => checkImageUrl("https://user:pw@s.alicdn.com/x.jpg", policy))).toBe("invalid_url");
    expect(await codeOf(() => checkImageUrl("https://s.alicdn.com:8443/x.jpg", policy))).toBe("invalid_url");
    expect(await codeOf(() => checkImageUrl("https://alicdn.com.evil.example/x.jpg", policy))).toBe("host_not_allowed");
    expect(await codeOf(() => checkImageUrl("https://127.0.0.1/x.jpg", policy))).toBe("host_not_allowed");
    expect(await codeOf(() => checkImageUrl("https://[::1]/x.jpg", policy))).toBe("host_not_allowed");
  });

  it("refuses DNS answers that point at private or metadata addresses", async () => {
    const resolver = (answers: dns.LookupAddress[]) =>
      ((_h: string, _o: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) => cb(null, answers)) as unknown as typeof dns.lookup;
    const lookupWith = (answers: dns.LookupAddress[]) =>
      new Promise<unknown>((resolve, reject) =>
        makeSafeLookup(resolver(answers))("s.alicdn.com", {}, (err: Error | null, address?: unknown) => (err ? reject(err) : resolve(address))),
      );
    expect(await lookupWith([{ address: "47.246.1.1", family: 4 }])).toBe("47.246.1.1");
    expect(await codeOf(lookupWith([{ address: "169.254.169.254", family: 4 }]))).toBe("private_address");
    expect(await codeOf(lookupWith([{ address: "47.246.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]))).toBe("private_address");
  });
});

describe("safeFetchImage", () => {
  const get = (responses: Awaited<ReturnType<HttpGet>>[]) => {
    const fn = vi.fn<HttpGet>(async () => responses.shift()!);
    return fn;
  };
  const ok = (contentType = "image/png") => ({ status: 200, location: null, contentType, bytes: png });

  it("returns image bytes and follows allowed redirects", async () => {
    const g = get([{ status: 302, location: "https://img.alicdn.com/kf/y.png", contentType: null, bytes: new Uint8Array() }, ok()]);
    const result = await safeFetchImage("https://s.alicdn.com/kf/x.png", policy, { get: g, lookup: (() => {}) as never });
    expect(result).toMatchObject({ url: "https://img.alicdn.com/kf/y.png", contentType: "image/png" });
    expect(g).toHaveBeenCalledTimes(2);
  });

  it("re-validates redirect destinations and limits redirects", async () => {
    const toLocal = get([{ status: 301, location: "https://localhost/x.png", contentType: null, bytes: new Uint8Array() }]);
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", policy, { get: toLocal, lookup: (() => {}) as never }))).toBe("host_not_allowed");
    const toHttp = get([{ status: 301, location: "http://s.alicdn.com/x.png", contentType: null, bytes: new Uint8Array() }]);
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", policy, { get: toHttp, lookup: (() => {}) as never }))).toBe("invalid_url");
    const loop = get(Array.from({ length: 5 }, () => ({ status: 302, location: "https://s.alicdn.com/again.png", contentType: null, bytes: new Uint8Array() })));
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", policy, { get: loop, lookup: (() => {}) as never }))).toBe("too_many_redirects");
  });

  it("rejects non-image content, HTTP errors and oversized bodies", async () => {
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", policy, { get: get([ok("text/html")]), lookup: (() => {}) as never }))).toBe("wrong_content_type");
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", policy, { get: get([{ ...ok(), status: 404 }]), lookup: (() => {}) as never }))).toBe("http_error");
    const big = { ...ok(), bytes: new Uint8Array(11) };
    expect(await codeOf(safeFetchImage("https://s.alicdn.com/x.png", { ...policy, maxBytes: 10 }, { get: get([big]), lookup: (() => {}) as never }))).toBe("too_large");
  });
});
