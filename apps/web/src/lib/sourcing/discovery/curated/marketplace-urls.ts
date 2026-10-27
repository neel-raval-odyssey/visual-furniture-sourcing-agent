import type { DataSourceKind } from "../../domain";

/**
 * Host rules for operator-supplied Alibaba.com records. Checked offline:
 * URLs are parsed, never fetched.
 *
 * Genuine ("live") records must point at Alibaba.com itself (alibaba.com or a
 * subdomain), and listing images at Alibaba.com or its alicdn.com image CDN.
 * Lookalikes such as "alibaba.com.example.net", "my-alibaba.com" or a
 * punycode homograph fail because only an exact host or a real subdomain
 * boundary (".alibaba.com") is accepted. Other Alibaba Group marketplaces
 * (1688.com, aliexpress.com) are different sources and are rejected.
 *
 * Synthetic ("mock") records must use reserved example domains (RFC 2606 /
 * RFC 6761), so a fixture can never look like a real listing, and a real
 * Alibaba URL can never appear in a fixture.
 */

export type UrlPurpose = "listing" | "supplier_profile" | "listing_image";

const PAGE_HOSTS = ["alibaba.com"];
const IMAGE_HOSTS = ["alibaba.com", "alicdn.com"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "test", "invalid"];

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function isReservedExampleHost(host: string): boolean {
  return RESERVED_DOMAINS.some((d) => onDomain(host, d)) || RESERVED_TLDS.some((tld) => host.endsWith(`.${tld}`));
}

/** Returns a problem description, or null when the URL is acceptable. */
export function checkMarketplaceUrl(value: string, purpose: UrlPurpose, dataSource: DataSourceKind): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  if (url.port) return "must not specify a port";
  const host = url.hostname.toLowerCase();

  if (dataSource === "mock") {
    if (!isReservedExampleHost(host)) {
      return "synthetic records must use a reserved example domain (example.com, *.example, *.test)";
    }
    return null;
  }
  const allowed = purpose === "listing_image" ? IMAGE_HOSTS : PAGE_HOSTS;
  if (!allowed.some((d) => onDomain(host, d))) {
    return `host "${host}" is not ${allowed.map((d) => `${d} or a subdomain of it`).join(", or ")}`;
  }
  return null;
}

/**
 * Product id from an Alibaba.com product-detail URL, e.g.
 * ".../product-detail/Some-Title_1601234567890.html" → "1601234567890".
 * Returns undefined when the URL does not follow that pattern.
 */
export function productIdFromListingUrl(value: string): string | undefined {
  const match = /\/product-detail\/(?:[^/]*_)?(\d{6,})\.html$/i.exec(new URL(value).pathname);
  return match?.[1];
}

/** Host + path, lower-cased host, without query, fragment or trailing slash. */
export function canonicalUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.toLowerCase()}${path}`;
}
