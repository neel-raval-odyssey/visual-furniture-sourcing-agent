import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/**
 * Bounded download of one provider-returned image URL. Only HTTPS URLs on an
 * allowlisted host (or its subdomains) are fetched; every DNS answer is checked
 * at connect time so loopback, private, link-local and metadata addresses are
 * refused even after a redirect or a changed DNS answer; redirects are
 * re-validated; size and time are capped; the response must declare an image
 * content type. No cookies or credentials are sent.
 */

export type ImageFetchErrorCode =
  | "invalid_url"
  | "host_not_allowed"
  | "private_address"
  | "dns_failed"
  | "too_many_redirects"
  | "http_error"
  | "timeout"
  | "too_large"
  | "wrong_content_type"
  | "network";

export class ImageFetchError extends Error {
  constructor(
    readonly code: ImageFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

export interface ImageFetchPolicy {
  /** Registrable domains; a host matches the domain itself or a subdomain. */
  allowedDomains: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const DEFAULT_IMAGE_FETCH_POLICY: ImageFetchPolicy = {
  allowedDomains: ["alicdn.com", "alibaba.com"],
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 3,
};

export interface FetchedImage {
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/** One HTTP GET without following redirects. Replaced in tests. */
export type HttpGet = (
  url: URL,
  options: { lookup: net.LookupFunction; timeoutMs: number; maxBytes: number },
) => Promise<{ status: number; location: string | null; contentType: string | null; bytes: Uint8Array }>;

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];

const v4ToInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const inV4 = (ip: string, [base, bits]: [string, number]) => bits === 0 || v4ToInt(ip) >>> (32 - bits) === v4ToInt(base) >>> (32 - bits);

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !V4_BLOCKED.some((range) => inV4(ip, range));
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]);
  if (lower === "::" || lower === "::1") return false;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (lower.startsWith("2001:db8") || lower.startsWith("64:ff9b") || lower.startsWith("100:")) return false;
  return true;
}

/** DNS lookup that refuses any non-public answer. */
export function makeSafeLookup(resolve: typeof dns.lookup = dns.lookup): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(new ImageFetchError("dns_failed", "DNS lookup failed"));
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0) return callback(new ImageFetchError("dns_failed", "DNS returned no address"));
      if (list.some((a) => !isPublicAddress(a.address))) {
        return callback(new ImageFetchError("private_address", "Host resolves to a non-public address"));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as net.LookupFunction;
}

export function checkImageUrl(value: string, policy: ImageFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageFetchError("invalid_url", "not a valid URL");
  }
  if (url.protocol !== "https:") throw new ImageFetchError("invalid_url", "only https URLs are fetched");
  if (url.username || url.password) throw new ImageFetchError("invalid_url", "URL contains credentials");
  if (url.port && url.port !== "443") throw new ImageFetchError("invalid_url", "non-standard port");
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) throw new ImageFetchError("host_not_allowed", "IP-address hosts are not fetched");
  if (!policy.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new ImageFetchError("host_not_allowed", `host ${host} is not on the image allowlist`);
  }
  return url;
}

export const nodeHttpGet: HttpGet = (url, { lookup, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup,
        timeout: timeoutMs,
        headers: { Accept: "image/jpeg,image/png,image/webp,image/avif;q=0.8", "User-Agent": "visual-furniture-sourcing-agent/0.1 (image evidence)" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location ?? null, contentType: null, bytes: new Uint8Array() });
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new ImageFetchError("too_large", `image exceeds ${maxBytes} bytes`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new ImageFetchError("too_large", `image exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, location: null, contentType: res.headers["content-type"] ?? null, bytes: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", () => reject(new ImageFetchError("network", "connection failed while reading")));
      },
    );
    const deadline = setTimeout(() => req.destroy(new ImageFetchError("timeout", `no complete response within ${timeoutMs} ms`)), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new ImageFetchError("timeout", `no response within ${timeoutMs} ms`)));
    req.on("error", (error) => reject(error instanceof ImageFetchError ? error : new ImageFetchError("network", "connection failed")));
  });

export async function safeFetchImage(
  value: string,
  policy: ImageFetchPolicy = DEFAULT_IMAGE_FETCH_POLICY,
  deps: { get?: HttpGet; lookup?: net.LookupFunction } = {},
): Promise<FetchedImage> {
  const get = deps.get ?? nodeHttpGet;
  const lookup = deps.lookup ?? makeSafeLookup();
  let url = checkImageUrl(value, policy);
  for (let hop = 0; ; hop++) {
    const res = await get(url, { lookup, timeoutMs: policy.timeoutMs, maxBytes: policy.maxBytes });
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new ImageFetchError("http_error", `redirect ${res.status} without a location`);
      if (hop >= policy.maxRedirects) throw new ImageFetchError("too_many_redirects", "too many redirects");
      url = checkImageUrl(new URL(res.location, url).toString(), policy);
      continue;
    }
    if (res.status !== 200) throw new ImageFetchError("http_error", `HTTP ${res.status}`);
    const contentType = (res.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new ImageFetchError("wrong_content_type", `content type "${contentType || "none"}" is not an image`);
    if (res.bytes.length > policy.maxBytes) throw new ImageFetchError("too_large", `image exceeds ${policy.maxBytes} bytes`);
    return { url: url.toString(), contentType, bytes: res.bytes };
  }
}
