import type { DataProvenance } from "./common";

/**
 * Supplier information as reported by a marketplace. Every optional field is
 * absent when unknown; absence never means "negative". For example, a missing
 * `verifications` list means verification status is unknown, not unverified.
 *
 * Supplier reliability is deliberately kept apart from visual similarity.
 */

/** A verification claim reported by the marketplace or a third party. */
export interface SupplierVerification {
  /** e.g. "business_license", "onsite_check". Open string. */
  type: string;
  status: "verified" | "not_verified";
  /** Who reported it, e.g. the marketplace name or an auditor. */
  reportedBy?: string;
}

export interface TradeAssuranceInfo {
  available: boolean;
  /** Coverage limit as reported, if any. */
  limit?: { amount: number; currency: string };
}

export interface SupplierResponsiveness {
  /** Percentage 0–100 as reported by the marketplace. */
  responseRatePercent?: number;
  /** Reported typical response time, e.g. "≤24h". Kept as reported. */
  typicalResponseTime?: string;
}

export interface SupplierProfile {
  id: string;
  name: string;
  profileUrl?: string;
  /** ISO 3166-1 alpha-2 country code when known, e.g. "CN". */
  countryCode?: string;
  /** Free-form location, e.g. "Foshan, Guangdong". */
  location?: string;
  /** e.g. "manufacturer", "trading_company". Open string. */
  classification?: string;
  verifications?: SupplierVerification[];
  /** Years on the platform, as reported. */
  platformTenureYears?: number;
  tradeAssurance?: TradeAssuranceInfo;
  responsiveness?: SupplierResponsiveness;
  provenance: DataProvenance;
}
