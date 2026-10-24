import { z } from "zod";
import type { CandidateListing, ListingImage, MinimumOrder, PriceInfo } from "../domain";
import {
  dataProvenanceSchema,
  httpUrlSchema,
  idSchema,
  imageRefSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";

const nonNegativeAmount = z.number().nonnegative();

export const priceInfoSchema = z
  .strictObject({
    min: nonNegativeAmount,
    max: nonNegativeAmount.optional(),
    /** ISO 4217, as documented on PriceInfo.currency. */
    currency: z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 code").optional(),
    unit: nonEmptyStringSchema.optional(),
  })
  .refine((p) => p.max === undefined || p.max >= p.min, {
    message: "max must be greater than or equal to min",
    path: ["max"],
  });

export const listingImageSchema = imageRefSchema.extend({
  role: nonEmptyStringSchema.optional(),
  alt: z.string().optional(),
});

export const minimumOrderSchema = z.strictObject({
  quantity: z.int().positive(),
  unit: nonEmptyStringSchema.optional(),
});

export const candidateListingSchema = z.strictObject({
  id: idSchema,
  marketplaceProductId: nonEmptyStringSchema.optional(),
  title: nonEmptyStringSchema,
  listingUrl: httpUrlSchema,
  images: z.array(listingImageSchema),
  category: nonEmptyStringSchema.optional(),
  /** Seller-reported, open-ended: every key is kept, values must be strings. */
  attributes: z.record(z.string(), z.string()).optional(),
  price: priceInfoSchema.optional(),
  minimumOrder: minimumOrderSchema.optional(),
  supplierId: idSchema.optional(),
  provenance: dataProvenanceSchema,
});

export type _PriceInfoCheck = Assert<SchemaMatches<typeof priceInfoSchema, PriceInfo>>;
export type _ListingImageCheck = Assert<SchemaMatches<typeof listingImageSchema, ListingImage>>;
export type _MinimumOrderCheck = Assert<SchemaMatches<typeof minimumOrderSchema, MinimumOrder>>;
export type _CandidateListingCheck = Assert<SchemaMatches<typeof candidateListingSchema, CandidateListing>>;
