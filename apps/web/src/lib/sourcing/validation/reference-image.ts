import { z } from "zod";
import type { CatalogueMetadata, ReferenceImage, ReferenceImageOrigin } from "../domain";
import {
  httpUrlSchema,
  idSchema,
  imageRefSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";

export const referenceImageOriginSchema = z.strictObject({
  kind: z.enum([
    "retail_website",
    "catalogue",
    "social_media",
    "marketplace",
    "personal_photo",
    "unknown",
  ]),
  platform: nonEmptyStringSchema.optional(),
});

export const catalogueMetadataSchema = z.strictObject({
  title: nonEmptyStringSchema.optional(),
  publisher: nonEmptyStringSchema.optional(),
  pageNumber: z.int().positive().optional(),
  itemCode: nonEmptyStringSchema.optional(),
});

export const referenceImageSchema = z.strictObject({
  id: idSchema,
  image: imageRefSchema,
  origin: referenceImageOriginSchema,
  sourceUrl: httpUrlSchema.optional(),
  submittedAt: isoTimestampSchema,
  catalogue: catalogueMetadataSchema.optional(),
  userNotes: z.string().optional(),
});

export type _ReferenceImageOriginCheck = Assert<SchemaMatches<typeof referenceImageOriginSchema, ReferenceImageOrigin>>;
export type _CatalogueMetadataCheck = Assert<SchemaMatches<typeof catalogueMetadataSchema, CatalogueMetadata>>;

export type _ReferenceImageCheck = Assert<SchemaMatches<typeof referenceImageSchema, ReferenceImage>>;
