import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CandidateManifest } from "./manifest";

/**
 * TEST-ONLY inputs for the curated intake. None of these describe real
 * products or suppliers.
 * - syntheticManifest(): dataSource "mock", reserved example domains.
 * - liveShapedManifest(): dataSource "live" with alibaba.com-shaped URLs, so the
 *   genuine-record rules can be tested. Its ids, titles and suppliers are
 *   invented and marked [TEST]; it exists only in memory during tests.
 */

export const REPO_ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));

/** The committed synthetic run record (reference ref-local-0ef9571d83494cd6). */
export function syntheticRunRecord(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(`${REPO_ROOT}evals/image-understanding/synthetic/predictions/syn-bed-001.json`, "utf8"),
  ) as Record<string, unknown>;
}

/**
 * A real-shaped saved run for testing the genuine path: the synthetic record
 * relabelled as a live model run for case "test-live-bed". Test only.
 */
export function liveShapedRunRecord(): Record<string, unknown> {
  const raw = syntheticRunRecord() as {
    caseId: string;
    dataSource: string;
    referenceId: string;
    result: { fingerprint: { id: string; referenceImageIds: string[]; source: unknown } };
  };
  Object.assign(raw, { caseId: "test-live-bed", dataSource: "live", referenceId: "ref-test-live" });
  Object.assign(raw.result.fingerprint, {
    id: "fp-test-live",
    referenceImageIds: ["ref-test-live"],
    source: { kind: "model", dataSource: "live", modelId: "gpt-6-luna" },
  });
  return raw;
}

export const SYN_CASE = "syn-bed-001";
export const SYN_REFERENCE = "ref-local-0ef9571d83494cd6";
export const SYN_FINGERPRINT = "fp-synthetic-syn-bed-001";

export function syntheticManifest(overrides: Partial<CandidateManifest> = {}): CandidateManifest {
  return {
    manifestType: "alibaba_candidate_manifest",
    schemaVersion: 1,
    dataSource: "mock",
    caseId: SYN_CASE,
    referenceImageId: SYN_REFERENCE,
    fingerprintId: SYN_FINGERPRINT,
    capture: {
      status: "completed",
      method: "operator_assisted",
      capturedAt: "2026-10-26T09:00:00.000Z",
      tools: ["alibaba_lens"],
      queriesTyped: [],
      notes: null,
    },
    suppliers: [
      { ref: "supplier-a", name: "[SYNTHETIC] Supplier A", profileUrl: "https://supplier-a.example.com/" },
      { ref: "supplier-b", name: "[SYNTHETIC] Supplier B" },
    ],
    candidates: [
      {
        listingUrl: "https://shop.example.com/product-detail/Bed_1000000000001.html",
        title: "[SYNTHETIC] Arched bed",
        images: [{ url: "https://img.example.com/1.jpg", role: "primary" }],
        price: { min: 100, max: 150, currency: "USD", unit: "piece" },
        minimumOrder: { quantity: 2 },
        attributes: { Material: "Wood" },
        supplierRef: "supplier-a",
        foundWith: "alibaba_lens",
      },
      {
        listingUrl: "https://shop.example.com/product-detail/Bed_1000000000002.html",
        title: "[SYNTHETIC] Arched bed",
        images: [],
        supplierRef: "supplier-b",
      },
      {
        listingUrl: "https://shop.example.com/listing/no-id",
        title: "[SYNTHETIC] Bed without product id",
        images: [{ url: "https://img.example.com/3.jpg" }],
      },
    ],
    ...overrides,
  };
}

export function liveShapedManifest(overrides: Partial<CandidateManifest> = {}): CandidateManifest {
  return {
    ...syntheticManifest(),
    dataSource: "live",
    caseId: "test-live-bed",
    referenceImageId: "ref-test-live",
    fingerprintId: "fp-test-live",
    suppliers: [{ ref: "supplier-a", name: "[TEST] Supplier", profileUrl: "https://testsupplier.en.alibaba.com/" }],
    candidates: [
      {
        listingUrl: "https://www.alibaba.com/product-detail/TEST-Bed_0000000001.html",
        title: "[TEST] Bed",
        images: [{ url: "https://s.alicdn.com/test/0000000001.jpg" }],
        supplierRef: "supplier-a",
      },
    ],
    ...overrides,
  };
}
