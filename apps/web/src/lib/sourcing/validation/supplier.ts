import { z } from "zod";
import type {
  SupplierProfile,
  SupplierResponsiveness,
  SupplierVerification,
  TradeAssuranceInfo,
} from "../domain";
import {
  dataProvenanceSchema,
  httpUrlSchema,
  idSchema,
  nonEmptyStringSchema,
} from "./common";
import type { Assert, SchemaMatches } from "./contract";

const isoCurrencySchema = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 code");

export const supplierVerificationSchema = z.strictObject({
  type: nonEmptyStringSchema,
  status: z.enum(["verified", "not_verified"]),
  reportedBy: nonEmptyStringSchema.optional(),
});

export const tradeAssuranceSchema = z.strictObject({
  available: z.boolean(),
  limit: z
    .strictObject({ amount: z.number().nonnegative(), currency: isoCurrencySchema })
    .optional(),
});

export const supplierResponsivenessSchema = z.strictObject({
  responseRatePercent: z.number().min(0).max(100).optional(),
  typicalResponseTime: nonEmptyStringSchema.optional(),
});

/**
 * Absent optional fields stay absent: no defaults are applied, so missing
 * verification data remains "unknown" and is never turned into
 * "not_verified" or `available: false`.
 */
export const supplierProfileSchema = z.strictObject({
  id: idSchema,
  name: nonEmptyStringSchema,
  profileUrl: httpUrlSchema.optional(),
  /** ISO 3166-1 alpha-2, as documented on SupplierProfile.countryCode. */
  countryCode: z.string().regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 code").optional(),
  location: nonEmptyStringSchema.optional(),
  classification: nonEmptyStringSchema.optional(),
  verifications: z.array(supplierVerificationSchema).optional(),
  platformTenureYears: z.number().nonnegative().optional(),
  tradeAssurance: tradeAssuranceSchema.optional(),
  responsiveness: supplierResponsivenessSchema.optional(),
  provenance: dataProvenanceSchema,
});

export type _SupplierVerificationCheck = Assert<SchemaMatches<typeof supplierVerificationSchema, SupplierVerification>>;
export type _TradeAssuranceCheck = Assert<SchemaMatches<typeof tradeAssuranceSchema, TradeAssuranceInfo>>;
export type _SupplierResponsivenessCheck = Assert<SchemaMatches<typeof supplierResponsivenessSchema, SupplierResponsiveness>>;
export type _SupplierProfileCheck = Assert<SchemaMatches<typeof supplierProfileSchema, SupplierProfile>>;
