import type {
  CandidateListing,
  DataProvenance,
  SupplierProfile,
} from "../../domain";

/**
 * SYNTHETIC FIXTURE DATA. Every product and supplier here is invented for
 * testing. None of it describes a real Alibaba listing or a real company.
 * All URLs use the reserved example.com domain.
 */

const MOCK_PROVENANCE: DataProvenance = {
  marketplace: "alibaba",
  dataSource: "mock",
  retrievedAt: "2026-01-01T00:00:00.000Z",
};

const BASE_URL = "https://example.com/mock-marketplace";

export const MOCK_SUPPLIERS: readonly SupplierProfile[] = [
  {
    id: "mock-supplier-001",
    name: "Synthetic Supplier Alpha (Mock)",
    profileUrl: `${BASE_URL}/suppliers/alpha`,
    countryCode: "CN",
    location: "Mock Province A",
    classification: "manufacturer",
    verifications: [
      { type: "business_license", status: "verified", reportedBy: "mock" },
    ],
    platformTenureYears: 8,
    tradeAssurance: { available: true, limit: { amount: 50000, currency: "USD" } },
    responsiveness: { responseRatePercent: 92, typicalResponseTime: "≤24h" },
    provenance: MOCK_PROVENANCE,
  },
  {
    id: "mock-supplier-002",
    name: "Synthetic Supplier Beta (Mock)",
    profileUrl: `${BASE_URL}/suppliers/beta`,
    countryCode: "VN",
    classification: "trading_company",
    verifications: [
      { type: "onsite_check", status: "not_verified", reportedBy: "mock" },
    ],
    platformTenureYears: 3,
    tradeAssurance: { available: false },
    provenance: MOCK_PROVENANCE,
  },
  {
    // Intentionally sparse: verification, tenure, trade assurance and
    // responsiveness are unknown, not negative.
    id: "mock-supplier-003",
    name: "Synthetic Supplier Gamma (Mock)",
    provenance: MOCK_PROVENANCE,
  },
];

export const MOCK_LISTINGS: readonly CandidateListing[] = [
  {
    id: "mock-listing-001",
    marketplaceProductId: "MOCK-0001",
    title: "[MOCK] Black metal dining chair with curved wooden backrest",
    listingUrl: `${BASE_URL}/products/0001`,
    images: [
      { uri: `${BASE_URL}/images/0001-front.jpg`, role: "primary" },
      { uri: `${BASE_URL}/images/0001-side.jpg`, role: "gallery" },
      { uri: `${BASE_URL}/images/0001-detail.jpg`, role: "detail" },
    ],
    category: "chair",
    attributes: { frame_material: "steel", seat_material: "plywood" },
    price: { min: 28, max: 35, currency: "USD", unit: "piece" },
    minimumOrder: { quantity: 50, unit: "pieces" },
    supplierId: "mock-supplier-001",
    provenance: MOCK_PROVENANCE,
  },
  {
    id: "mock-listing-002",
    marketplaceProductId: "MOCK-0002",
    title: "[MOCK] Upholstered dining chair with tapered wooden legs",
    listingUrl: `${BASE_URL}/products/0002`,
    images: [
      { uri: `${BASE_URL}/images/0002-front.jpg`, role: "primary" },
      { uri: `${BASE_URL}/images/0002-back.jpg`, role: "gallery" },
    ],
    category: "chair",
    attributes: { upholstery: "linen-look fabric" },
    price: { min: 42, currency: "USD", unit: "piece" },
    minimumOrder: { quantity: 20 },
    supplierId: "mock-supplier-002",
    provenance: MOCK_PROVENANCE,
  },
  {
    id: "mock-listing-003",
    marketplaceProductId: "MOCK-0003",
    title: "[MOCK] Rattan lounge chair with wide armrests",
    listingUrl: `${BASE_URL}/products/0003`,
    images: [{ uri: `${BASE_URL}/images/0003-front.jpg`, role: "primary" }],
    category: "chair",
    supplierId: "mock-supplier-003",
    provenance: MOCK_PROVENANCE,
  },
  {
    id: "mock-listing-004",
    marketplaceProductId: "MOCK-0004",
    title: "[MOCK] Round oak-look dining table with pedestal base",
    listingUrl: `${BASE_URL}/products/0004`,
    images: [
      { uri: `${BASE_URL}/images/0004-front.jpg`, role: "primary" },
      { uri: `${BASE_URL}/images/0004-top.jpg`, role: "gallery" },
    ],
    category: "table",
    attributes: { top_material: "MDF with oak veneer", diameter_cm: "120" },
    price: { min: 160, max: 210, currency: "USD", unit: "piece" },
    minimumOrder: { quantity: 10, unit: "pieces" },
    supplierId: "mock-supplier-001",
    provenance: MOCK_PROVENANCE,
  },
  {
    id: "mock-listing-005",
    marketplaceProductId: "MOCK-0005",
    title: "[MOCK] Rectangular coffee table with black metal frame",
    listingUrl: `${BASE_URL}/products/0005`,
    images: [{ uri: `${BASE_URL}/images/0005-front.jpg`, role: "primary" }],
    category: "table",
    price: { min: 75, currency: "USD" },
    supplierId: "mock-supplier-002",
    provenance: MOCK_PROVENANCE,
  },
  {
    // Intentionally incomplete: no marketplace id, category, attributes,
    // price, MOQ, supplier or images.
    id: "mock-listing-006",
    title: "[MOCK] Side table with marble-look top",
    listingUrl: `${BASE_URL}/products/0006`,
    images: [],
    provenance: MOCK_PROVENANCE,
  },
];
