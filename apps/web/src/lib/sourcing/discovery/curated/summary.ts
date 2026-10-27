import type { SourcingPipelineResult } from "../../pipeline/sourcing-pipeline";
import { summarizeSourcingRun } from "../../pipeline/summary";
import type { CuratedImport, ListingField, SupplierField } from "./curated-alibaba-adapter";

/** JSON-friendly view of an operator-assisted candidate import run. */
export interface CuratedRunSummary {
  synthetic: boolean;
  caseId: string;
  reference: {
    referenceImageId: string;
    fingerprintId: string;
    category: string;
    subtype: string | null;
    fingerprintSource: { kind: string; dataSource: string; modelId: string | null };
  };
  acquisition: {
    marketplace: string;
    providerId: string;
    method: string;
    /** Always false: candidates were found by a person on Alibaba.com. */
    searchPerformedByApplication: false;
    tools: string[];
    queriesTyped: string[];
    capturedAt: string;
  };
  counts: { candidates: number; suppliers: number; skippedDuplicates: number; excludedByLimit: number };
  candidates: {
    listingId: string;
    title: string;
    listingUrl: string;
    marketplaceProductId: string | null;
    category: string | null;
    attributes: Record<string, string>;
    price: string | null;
    minimumOrder: string | null;
    supplier: { id: string; name: string } | null;
    foundWith: string | null;
    imageEvidence: CuratedImport["info"][number]["imageEvidence"];
    missingFields: ListingField[];
    visualVerification: "not_assessed";
  }[];
  suppliers: { id: string; name: string; profileUrl: string | null; missingFields: SupplierField[] }[];
  visualVerification: { status: "not_implemented"; assessedCandidates: number };
}

export function summarizeCuratedRun(run: SourcingPipelineResult, imported: CuratedImport, caseId: string): CuratedRunSummary {
  const base = summarizeSourcingRun(run);
  const infoById = new Map(imported.info.map((i) => [i.listingId, i]));
  const suppliers = new Map(run.discovery.suppliers.map((s) => [s.id, s]));
  const fp = run.fingerprint;
  return {
    synthetic: base.containsSyntheticData,
    caseId,
    reference: {
      referenceImageId: run.reference.id,
      fingerprintId: fp.id,
      category: fp.category,
      subtype: fp.subtype ?? null,
      fingerprintSource: { kind: fp.source.kind, dataSource: fp.source.dataSource, modelId: fp.source.modelId ?? null },
    },
    acquisition: {
      marketplace: run.discovery.provider.marketplace,
      providerId: run.discovery.provider.providerId,
      method: run.discovery.provider.acquisitionMethod ?? "unrecorded",
      searchPerformedByApplication: false,
      tools: imported.tools,
      queriesTyped: imported.queriesTyped,
      capturedAt: run.discovery.retrievedAt,
    },
    counts: {
      candidates: run.discovery.listings.length,
      suppliers: run.discovery.suppliers.length,
      skippedDuplicates: imported.skippedDuplicates.length,
      excludedByLimit: imported.excludedByLimit,
    },
    // Discovery (recording) order, not the provisional rank: nothing has been assessed.
    candidates: run.discovery.listings.map((l) => {
      const info = infoById.get(l.id);
      const supplier = l.supplierId ? suppliers.get(l.supplierId) : undefined;
      const p = l.price;
      return {
        listingId: l.id,
        title: l.title,
        listingUrl: l.listingUrl,
        marketplaceProductId: l.marketplaceProductId ?? null,
        category: l.category ?? null,
        attributes: l.attributes ?? {},
        price: p ? `${p.min}${p.max !== undefined ? `–${p.max}` : ""}${p.currency ? ` ${p.currency}` : ""}${p.unit ? ` / ${p.unit}` : ""}` : null,
        minimumOrder: l.minimumOrder ? `${l.minimumOrder.quantity}${l.minimumOrder.unit ? ` ${l.minimumOrder.unit}` : ""}` : null,
        supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
        foundWith: info?.foundWith ?? null,
        imageEvidence: info?.imageEvidence ?? { remote: 0, local: 0, suitableForVisualComparison: l.images.length > 0 },
        missingFields: info?.missingFields ?? [],
        visualVerification: "not_assessed" as const,
      };
    }),
    suppliers: run.discovery.suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      profileUrl: s.profileUrl ?? null,
      missingFields: imported.missingSupplierFields[s.id] ?? [],
    })),
    visualVerification: { status: "not_implemented", assessedCandidates: run.assessments.length },
  };
}

export function renderCuratedRunSummary(s: CuratedRunSummary): string {
  const lines: string[] = [];
  if (s.synthetic) lines.push("SYNTHETIC: contains synthetic data; these are not real Alibaba.com listings.");
  lines.push(`# Candidate import: ${s.caseId}`);
  lines.push(`Reference ${s.reference.referenceImageId}, fingerprint ${s.reference.fingerprintId} (${s.reference.fingerprintSource.dataSource}${s.reference.fingerprintSource.modelId ? `, ${s.reference.fingerprintSource.modelId}` : ""}): ${s.reference.category}${s.reference.subtype ? ` / ${s.reference.subtype}` : ""}`);
  lines.push(
    `Acquisition: ${s.acquisition.method} via ${s.acquisition.providerId} (${s.acquisition.marketplace}); captured ${s.acquisition.capturedAt}; tools: ${s.acquisition.tools.join(", ") || "none recorded"}. This application performed no search.`,
  );
  lines.push(
    `Candidates: ${s.counts.candidates}; suppliers: ${s.counts.suppliers}; duplicates skipped: ${s.counts.skippedDuplicates}; not returned because of --limit: ${s.counts.excludedByLimit}.`,
  );
  if (s.counts.candidates === 0) lines.push("The operator recorded a completed search with no candidates.");
  s.candidates.forEach((c, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${c.title}`);
    lines.push(`   ${c.listingUrl}`);
    lines.push(`   id ${c.listingId}${c.marketplaceProductId ? `, product ${c.marketplaceProductId}` : ""}; found with ${c.foundWith ?? "unrecorded"}`);
    lines.push(`   supplier: ${c.supplier ? c.supplier.name : "not recorded"}; price: ${c.price ?? "not recorded"}; MOQ: ${c.minimumOrder ?? "not recorded"}`);
    const attrs = Object.entries(c.attributes);
    if (attrs.length > 0) lines.push(`   attributes (seller-reported): ${attrs.map(([k, v]) => `${k}=${v}`).join("; ")}`);
    lines.push(
      `   images: ${c.imageEvidence.remote} remote, ${c.imageEvidence.local} local${c.imageEvidence.suitableForVisualComparison ? "" : ": UNSUITABLE for visual comparison (no image evidence)"}`,
    );
    if (c.missingFields.length > 0) lines.push(`   missing: ${c.missingFields.join(", ")}`);
    lines.push("   visual verification: not assessed");
  });
  if (s.suppliers.length > 0) {
    lines.push("");
    lines.push("Suppliers:");
    for (const sup of s.suppliers) {
      lines.push(`- ${sup.name}${sup.profileUrl ? ` (${sup.profileUrl})` : ""}; missing: ${sup.missingFields.join(", ") || "none"}`);
    }
  }
  lines.push("");
  lines.push("Visual matching is not implemented: no similarity, confidence or match classification has been produced.");
  return lines.join("\n");
}
