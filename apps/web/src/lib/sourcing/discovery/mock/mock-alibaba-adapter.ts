import type { CandidateListing, SupplierProfile } from "../../domain";
import type {
  AlibabaDiscoveryAdapter,
  DiscoveryProviderInfo,
  DiscoverySearchRequest,
  DiscoverySearchResult,
} from "../types";
import { MOCK_LISTINGS, MOCK_SUPPLIERS } from "./fixtures";

export const MOCK_PROVIDER_INFO: DiscoveryProviderInfo = {
  providerId: "mock-alibaba",
  marketplace: "alibaba",
  dataSource: "mock",
};

export interface MockAlibabaDiscoveryAdapterOptions {
  listings?: readonly CandidateListing[];
  suppliers?: readonly SupplierProfile[];
  /** Clock for `retrievedAt`. Inject a fixed clock for deterministic tests. */
  now?: () => Date;
}

/**
 * Fixture-backed discovery adapter. Makes no network requests.
 *
 * Filtering is deliberately simple:
 * - category (request or fingerprint) must equal the listing category;
 * - a listing matches a text query when every query word appears in its
 *   title, category or attribute values; it is kept if it matches any query;
 * - image content is not inspected, so image-only requests rely on category.
 * Fixture order is preserved; no scoring or ranking takes place.
 */
export class MockAlibabaDiscoveryAdapter implements AlibabaDiscoveryAdapter {
  private readonly listings: readonly CandidateListing[];
  private readonly suppliers: readonly SupplierProfile[];
  private readonly now: () => Date;

  constructor(options: MockAlibabaDiscoveryAdapterOptions = {}) {
    this.listings = options.listings ?? MOCK_LISTINGS;
    this.suppliers = options.suppliers ?? MOCK_SUPPLIERS;
    this.now = options.now ?? (() => new Date());
  }

  async discoverCandidates(
    input: DiscoverySearchRequest,
  ): Promise<DiscoverySearchResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new RangeError(
        `limit must be a positive integer, received ${input.limit}`,
      );
    }

    const category = input.category ?? input.fingerprint?.category;
    const queries =
      input.mode === "image"
        ? []
        : (input.queries ?? input.fingerprint?.searchQueries ?? []);

    const matched = this.listings
      .filter((listing) => matchesCategory(listing, category))
      .filter((listing) => matchesAnyQuery(listing, queries))
      .slice(0, input.limit);

    const supplierIds = new Set(
      matched.flatMap((listing) => listing.supplierId ?? []),
    );

    return {
      listings: structuredClone(matched),
      suppliers: structuredClone(
        this.suppliers.filter((supplier) => supplierIds.has(supplier.id)),
      ),
      provider: { ...MOCK_PROVIDER_INFO },
      retrievedAt: this.now().toISOString(),
      queriesUsed: [...queries],
      categoryUsed: category,
    };
  }
}

function normalize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchesCategory(
  listing: CandidateListing,
  category: string | undefined,
): boolean {
  if (!category) return true;
  return listing.category?.toLowerCase() === category.toLowerCase();
}

function matchesAnyQuery(
  listing: CandidateListing,
  queries: string[],
): boolean {
  const usable = queries.map(normalize).filter((words) => words.length > 0);
  if (usable.length === 0) return true;

  const haystack = new Set(
    normalize(
      [
        listing.title,
        listing.category ?? "",
        ...Object.values(listing.attributes ?? {}),
      ].join(" "),
    ),
  );
  return usable.some((words) => words.every((word) => haystack.has(word)));
}
