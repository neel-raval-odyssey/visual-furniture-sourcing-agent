import { z } from "zod";
import type { DiscoveryProviderInfo, DiscoverySearchResult } from "../discovery/types";
import {
  acquisitionMethodSchema,
  dataSourceKindSchema,
  isoTimestampSchema,
  marketplaceIdSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";
import { candidateListingSchema } from "./listing";
import { supplierProfileSchema } from "./supplier";

export const discoveryProviderInfoSchema = z.strictObject({
  providerId: nonEmptyStringSchema,
  marketplace: marketplaceIdSchema,
  dataSource: dataSourceKindSchema,
  acquisitionMethod: acquisitionMethodSchema.optional(),
});

/**
 * Structure only. Empty listings are valid; listings may reference suppliers
 * that are absent. Duplicate ids and supplier links are checked by the
 * pipeline's integrity rules, not here.
 */
export const discoverySearchResultSchema = z.strictObject({
  listings: z.array(candidateListingSchema),
  suppliers: z.array(supplierProfileSchema),
  provider: discoveryProviderInfoSchema,
  retrievedAt: isoTimestampSchema,
  queriesUsed: z.array(z.string()),
  categoryUsed: nonEmptyStringSchema.optional(),
});

export type _DiscoveryProviderInfoCheck = Assert<SchemaMatches<typeof discoveryProviderInfoSchema, DiscoveryProviderInfo>>;
export type _DiscoverySearchResultCheck = Assert<SchemaMatches<typeof discoverySearchResultSchema, DiscoverySearchResult>>;
