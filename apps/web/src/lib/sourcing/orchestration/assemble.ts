import type { CuratedImport } from "../discovery/curated/curated-alibaba-adapter";
import { candidateIdentity, type CandidateManifest } from "../discovery/curated/manifest";
import type { RawFeatureComparison } from "../verification/openai/raw-response";
import type { StageName, StageState } from "./journal";
import type { CandidateStage, ListingEvidence, ListingVerification, ReferenceStage, SelectionOutcome, ShortlistStage, VerificationSettings } from "./stages";

/**
 * Consolidated sourcing result. Verified candidates are ordered by the Sol
 * design similarity index (the "verification ordering"), ties by listing id.
 * SigLIP cosine and rank are shown alongside as retrieval signals and never
 * combined with it. Every candidate appears exactly once: unverified ones are
 * listed separately with the reason, never scored 0.
 */

export const VERIFICATION_ORDERING =
  "Verified candidates ordered by the GPT-6.1 Sol design similarity index (descending; ties by listing id). The index is a model judgement on a 0–100 scale, not a probability or a calibrated accuracy. SigLIP 2 cosine and rank are retrieval signals shown for reference only; no weighted combination is used.";

export interface EvidenceItem {
  feature: string;
  importance: string;
  aspect: string;
  basis: string;
  reference: string | null;
  candidate: string | null;
  explanation: string;
  limitation: string | null;
}

export interface SourcingEntry {
  listingId: string;
  marketplaceProductId: string | null;
  title: string;
  listingUrl: string;
  /** Marketplace-reported data, as recorded; nothing converted or inferred. */
  product: {
    category: string | null;
    price: { min: number; max: number | null; currency: string | null; unit: string | null } | null;
    priceTiers: CandidateManifest["candidates"][number]["priceTiers"] | null;
    minimumOrder: { quantity: number; unit: string | null } | null;
    attributes: Record<string, string> | null;
    missingFields: string[];
  };
  supplier: {
    id: string;
    name: string;
    profileUrl: string | null;
    countryCode: string | null;
    location: string | null;
    classification: string | null;
    /** Claims displayed by the marketplace (with who reported them); not verified by this application. */
    marketplaceClaims: string[];
    platformTenureYears: number | null;
    missingFields: string[];
  } | null;
  provenance: { acquisitionMethod: string; providerId: string | null; providerAccess: string | null; providerRunIds: string[]; capturedAt: string };
  imageEvidence: { status: ListingEvidence["status"]; image: ListingEvidence["image"]; problems: ListingEvidence["problems"] };
  retrieval: { siglipRank: number | null; embeddingCosineSimilarity: number | null };
  verification: {
    status: ListingVerification["status"];
    selected: boolean;
    selectionNote: string;
    verificationRank: number | null;
    designSimilarityIndex: number | null;
    classification: string | null;
    confidence: string | null;
    summary: string | null;
    matches: EvidenceItem[];
    /** Partial matches on structural features: real differences, not full contradictions. */
    partialStructuralDifferences: EvidenceItem[];
    structuralMismatches: EvidenceItem[];
    appearanceDifferences: EvidenceItem[];
    limitations: string[];
    uncertainClaims: string[];
    model: string | null;
    instructionsVersion: string | null;
    record: string | null;
    notes: string[];
  };
}

export interface SourcingResult {
  recordType: "sourcing_result";
  schemaVersion: 1;
  runId: string;
  caseId: string;
  createdAt: string;
  synthetic: boolean;
  reference: { referenceImageId: string; sha256: string; fingerprintId: string; fingerprintModel: string | null; category: string; subtype: string | null };
  source: {
    kind: string;
    label: string;
    acquisitionMethod: string;
    providers: { providerId: string; access: string; source: string }[];
    manifestSha256: string;
    discovery: CandidateStage["discovery"];
  };
  stages: Record<StageName, { state: StageState; message: string | null }>;
  counts: {
    candidates: number;
    withLocalImage: number;
    withoutUsableImage: number;
    shortlisted: number;
    verified: number;
    abstained: number;
    unverified: number;
  };
  ordering: string;
  models: {
    siglip: { id: string; revision: string; source: string | null; createdAt: string | null; preprocessing: Record<string, unknown> | null } | null;
    sol: VerificationSettings;
  };
  selection: { policy: string; excluded: SelectionOutcome["excluded"]; paidRequestsNeeded: number };
  /** Usage recorded in the reused Sol records (tokens), when present. */
  recordedUsage: { solResponses: number; inputTokens: number; outputTokens: number; reasoningTokens: number };
  externalRequestsMade: 0;
  verified: SourcingEntry[];
  /** Assessed but the model abstained (insufficient_evidence, null index). */
  abstained: SourcingEntry[];
  unverified: SourcingEntry[];
  warnings: string[];
  followUps: string[];
}

const item = (f: RawFeatureComparison): EvidenceItem => ({
  feature: f.feature,
  importance: f.importance,
  aspect: f.aspect,
  basis: f.evidence_basis,
  reference: f.reference_observation,
  candidate: f.candidate_observation,
  explanation: f.explanation,
  limitation: f.visibility_limitation,
});

const structural = (f: RawFeatureComparison) => f.aspect !== "surface_appearance";

export interface AssembleInput {
  runId: string;
  createdAt: string;
  caseId: string;
  synthetic: boolean;
  sourceKind: string;
  sourceLabel: string;
  ref: ReferenceStage;
  candidates: CandidateStage;
  evidence: ListingEvidence[];
  shortlist: ShortlistStage;
  verification: ListingVerification[];
  selection: SelectionOutcome;
  selectionLabel: string;
  sol: VerificationSettings;
  stages: Record<StageName, { state: StageState; message: string | null }>;
  warnings: string[];
  followUps: string[];
}

export function assembleSourcingResult(input: AssembleInput): SourcingResult {
  const imported: CuratedImport = input.candidates.imported;
  const suppliers = new Map(imported.suppliers.map((s) => [s.id, s]));
  const infoById = new Map(imported.info.map((i) => [i.listingId, i]));
  const manifestByIdentity = new Map(input.candidates.manifest.candidates.map((c) => [candidateIdentity(c), c]));
  const evidenceById = new Map(input.evidence.map((e) => [e.listingId, e]));
  const verificationById = new Map(input.verification.map((v) => [v.listingId, v]));

  const entries: SourcingEntry[] = imported.listings.map((l) => {
    const info = infoById.get(l.id)!;
    const manifestCandidate = manifestByIdentity.get(info.identity);
    const s = l.supplierId ? suppliers.get(l.supplierId) : undefined;
    const ev = evidenceById.get(l.id)!;
    const v = verificationById.get(l.id)!;
    const r = input.shortlist.entries.get(l.id);
    const raw = v.status === "reused" ? v.record!.record.rawVerification : null;
    const a = v.status === "reused" ? v.record!.record.assessment : null;
    const features = raw?.features ?? [];
    return {
      listingId: l.id,
      marketplaceProductId: l.marketplaceProductId ?? null,
      title: l.title,
      listingUrl: l.listingUrl,
      product: {
        category: l.category ?? null,
        price: l.price ? { min: l.price.min, max: l.price.max ?? null, currency: l.price.currency ?? null, unit: l.price.unit ?? null } : null,
        priceTiers: manifestCandidate?.priceTiers ?? null,
        minimumOrder: l.minimumOrder ? { quantity: l.minimumOrder.quantity, unit: l.minimumOrder.unit ?? null } : null,
        attributes: l.attributes ?? null,
        missingFields: info.missingFields,
      },
      supplier: s
        ? {
            id: s.id,
            name: s.name,
            profileUrl: s.profileUrl ?? null,
            countryCode: s.countryCode ?? null,
            location: s.location ?? null,
            classification: s.classification ?? null,
            marketplaceClaims: [
              ...(s.verifications ?? []).map((x) => `${x.type}: ${x.status}${x.reportedBy ? ` (reported by ${x.reportedBy})` : ""}`),
              ...(s.tradeAssurance?.available ? ["Trade Assurance shown"] : []),
            ],
            platformTenureYears: s.platformTenureYears ?? null,
            missingFields: imported.missingSupplierFields[s.id] ?? [],
          }
        : null,
      provenance: {
        acquisitionMethod: l.provenance.acquisitionMethod ?? "unrecorded",
        providerId: l.provenance.providerSource?.providerId ?? null,
        providerAccess: l.provenance.providerSource?.access ?? null,
        providerRunIds: l.provenance.providerSource?.runIds ?? [],
        capturedAt: l.provenance.retrievedAt,
      },
      imageEvidence: { status: ev.status, image: ev.image, problems: ev.problems },
      retrieval: { siglipRank: r?.rank ?? null, embeddingCosineSimilarity: r?.cosine ?? null },
      verification: {
        status: v.status,
        selected: v.selected,
        selectionNote: v.selectionNote,
        verificationRank: null,
        designSimilarityIndex: a?.designSimilarityIndex ?? null,
        classification: a?.classification ?? null,
        confidence: a?.confidence ?? null,
        summary: raw?.summary ?? null,
        matches: features.filter((f) => f.comparison === "match" && f.importance !== "minor").map(item),
        partialStructuralDifferences: features.filter((f) => f.comparison === "partial_match" && structural(f)).map(item),
        structuralMismatches: features.filter((f) => f.comparison === "mismatch" && structural(f)).map(item),
        appearanceDifferences: features.filter((f) => (f.comparison === "mismatch" || f.comparison === "partial_match") && !structural(f)).map(item),
        limitations: [
          ...features.filter((f) => f.comparison === "not_comparable").map((f) => `${f.feature}: ${f.visibility_limitation ?? f.explanation}`),
          ...(raw?.visibility_limitations ?? []),
        ],
        uncertainClaims: raw?.uncertain_claims ?? [],
        model: v.record?.record.response?.responseModel || v.record?.record.request.model || null,
        instructionsVersion: v.record?.record.request.instructionsVersion ?? null,
        record: v.record?.file ?? null,
        notes: v.notes,
      },
    };
  });

  const verified = entries
    .filter((e) => e.verification.status === "reused" && e.verification.designSimilarityIndex !== null)
    .sort((a, b) => b.verification.designSimilarityIndex! - a.verification.designSimilarityIndex! || (a.listingId < b.listingId ? -1 : 1));
  verified.forEach((e, i) => (e.verification.verificationRank = i + 1));
  const abstained = entries.filter((e) => e.verification.status === "reused" && e.verification.designSimilarityIndex === null).sort((a, b) => (a.listingId < b.listingId ? -1 : 1));
  const unverified = entries
    .filter((e) => e.verification.status !== "reused")
    .sort((a, b) => (a.retrieval.siglipRank ?? Infinity) - (b.retrieval.siglipRank ?? Infinity) || (a.listingId < b.listingId ? -1 : 1));

  const usage = { solResponses: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  for (const v of input.verification) {
    const u = v.status === "reused" ? v.record?.record.response?.usage : null;
    if (!u) continue;
    usage.solResponses++;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.reasoningTokens += u.reasoningTokens ?? 0;
  }

  const fp = input.ref.saved.fingerprint;
  return {
    recordType: "sourcing_result",
    schemaVersion: 1,
    runId: input.runId,
    caseId: input.caseId,
    createdAt: input.createdAt,
    synthetic: input.synthetic,
    reference: {
      referenceImageId: input.ref.saved.reference.id,
      sha256: input.ref.saved.record.image.sha256,
      fingerprintId: fp.id,
      fingerprintModel: fp.source.modelId ?? null,
      category: fp.category,
      subtype: fp.subtype ?? null,
    },
    source: {
      kind: input.sourceKind,
      label: input.sourceLabel,
      acquisitionMethod: imported.acquisitionMethod,
      providers: imported.providers.map((p) => ({ providerId: p.providerId, access: p.access, source: p.source })),
      manifestSha256: input.candidates.manifestSha256,
      discovery: input.candidates.discovery,
    },
    stages: input.stages,
    counts: {
      candidates: entries.length,
      withLocalImage: input.evidence.filter((e) => e.status === "available").length,
      withoutUsableImage: input.evidence.filter((e) => e.status !== "available").length,
      shortlisted: input.shortlist.entries.size,
      verified: verified.length,
      abstained: abstained.length,
      unverified: unverified.length,
    },
    ordering: VERIFICATION_ORDERING,
    models: {
      siglip: input.shortlist.model
        ? { ...input.shortlist.model, source: input.shortlist.source, createdAt: input.shortlist.createdAt, preprocessing: input.shortlist.preprocessing }
        : null,
      sol: input.sol,
    },
    selection: { policy: input.selectionLabel, excluded: input.selection.excluded, paidRequestsNeeded: input.selection.toRequest.length },
    recordedUsage: usage,
    externalRequestsMade: 0,
    verified,
    abstained,
    unverified,
    warnings: input.warnings,
    followUps: input.followUps,
  };
}

// ---------------------------------------------------------------- Markdown

const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const evidenceLines = (title: string, items: EvidenceItem[]) =>
  items.length
    ? [`- **${title}:**`, ...items.map((i) => `  - ${i.feature} (${i.importance}, ${i.basis}): reference — ${i.reference ?? "not visible"}; candidate — ${i.candidate ?? "not visible"}. ${i.explanation}`)]
    : [`- **${title}:** none recorded`];

function productLines(e: SourcingEntry): string[] {
  const p = e.product;
  const price = p.price ? `${p.price.min}${p.price.max !== null && p.price.max !== p.price.min ? `–${p.price.max}` : ""} ${p.price.currency ?? "(currency not recorded)"}${p.price.unit ? ` / ${p.price.unit}` : ""}` : "not recorded";
  const lines = [
    `- Listing: [${cell(e.title)}](${e.listingUrl}) — product ID ${e.marketplaceProductId ?? "not recorded"}`,
    `- Price (as listed, not converted): ${price}${p.priceTiers?.length ? `; tiers: ${p.priceTiers.map((t) => `${t.minQuantity}${t.maxQuantity ? `–${t.maxQuantity}` : "+"}: ${t.price}${t.currency ? ` ${t.currency}` : ""}`).join(", ")}` : ""}`,
    `- MOQ: ${p.minimumOrder ? `${p.minimumOrder.quantity}${p.minimumOrder.unit ? ` ${p.minimumOrder.unit}` : ""}` : "not recorded"}`,
  ];
  if (p.attributes) lines.push(`- Seller-reported attributes (unverified): ${Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  const s = e.supplier;
  lines.push(
    s
      ? `- Supplier: ${s.name}${s.profileUrl ? ` ([profile](${s.profileUrl}))` : ""}; ${[s.countryCode, s.location].filter(Boolean).join(", ") || "location not recorded"}${s.platformTenureYears !== null ? `; ${s.platformTenureYears} years on platform` : ""}${s.marketplaceClaims.length ? `; marketplace claims (not verified here): ${s.marketplaceClaims.join(", ")}` : ""}`
      : "- Supplier: not recorded",
  );
  if (p.missingFields.length) lines.push(`- Missing listing fields: ${p.missingFields.join(", ")}`);
  lines.push(`- Acquisition: ${e.provenance.acquisitionMethod}${e.provenance.providerId ? ` via ${e.provenance.providerId} (${e.provenance.providerAccess})` : ""}; captured ${e.provenance.capturedAt}`);
  return lines;
}

export function renderSourcingResultMarkdown(r: SourcingResult): string {
  const L: string[] = [`# Sourcing result: ${r.caseId}`, "", `Run ${r.runId}, created ${r.createdAt}. External requests made by this run: 0.`, ""];
  if (r.synthetic) L.push("**SYNTHETIC:** contains synthetic data; these are not real Alibaba.com listings.", "");
  L.push(
    "## 1. Reference",
    "",
    `- Reference ${r.reference.referenceImageId} (sha256 ${r.reference.sha256})`,
    `- Fingerprint ${r.reference.fingerprintId} (${r.reference.fingerprintModel ?? "no model"}): ${r.reference.category}${r.reference.subtype ? ` / ${r.reference.subtype}` : ""}`,
    "",
    "## 2. Source",
    "",
    `- ${r.source.label}; acquisition ${r.source.acquisitionMethod}${r.source.providers.length ? `; provider ${r.source.providers.map((p) => `${p.providerId} (${p.source}, ${p.access})`).join(", ")}` : ""}`,
  );
  if (r.source.discovery) {
    const d = r.source.discovery;
    L.push(
      `- Discovery ${d.discoveryId}: recorded status ${d.state.recordedStatus} — ${d.state.meaning}; external work pending: ${d.state.externalWorkPending ? "yes" : "no"}; manifest ${d.manifestOrigin.replace(/_/g, " ")}`,
      `- Provider diagnostics: ${d.providerErrors.length ? d.providerErrors.map((e) => `${e.mode} ${e.code}: ${e.message}`).join("; ") : "none"}; rejected rows ${Object.entries(d.rejectedRows).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    );
  }
  L.push("", "## 3. Stages", "", "| Stage | State | Note |", "| --- | --- | --- |");
  for (const [name, s] of Object.entries(r.stages)) L.push(`| ${name} | ${s.state} | ${cell(s.message ?? "")} |`);
  const c = r.counts;
  L.push(
    "",
    "## 4–5. Candidates and visual-evidence coverage",
    "",
    `- Candidates ${c.candidates}; with a usable local image ${c.withLocalImage}; without ${c.withoutUsableImage}; SigLIP-ranked ${c.shortlisted}; verified ${c.verified}; abstained ${c.abstained}; unverified ${c.unverified}`,
    `- Selection policy: ${r.selection.policy}; new paid verification requests needed: ${r.selection.paidRequestsNeeded}`,
    "",
    "## 6. Verified candidates (verification ordering)",
    "",
    `_${r.ordering}_`,
    "",
    "| Rank | Product | Sol index | Classification | Confidence | SigLIP rank | Cosine | Supplier |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const e of r.verified) {
    const v = e.verification;
    L.push(
      `| ${v.verificationRank} | [${e.marketplaceProductId ?? e.listingId}](${e.listingUrl}) | ${v.designSimilarityIndex} | ${v.classification} | ${v.confidence} | ${e.retrieval.siglipRank ?? "—"} | ${e.retrieval.embeddingCosineSimilarity?.toFixed(4) ?? "—"} | ${cell(e.supplier?.name ?? "not recorded")} |`,
    );
  }
  if (r.verified.length === 0) L.push("| — | No verified candidates | — | — | — | — | — | — |");
  L.push("", "## 7. Unverified candidates (not scored; never treated as non-matches)", "");
  for (const e of [...r.abstained, ...r.unverified]) {
    L.push(`- [${e.marketplaceProductId ?? e.listingId}](${e.listingUrl}) — ${e.verification.status === "reused" ? "model abstained (insufficient evidence)" : e.verification.status}; image ${e.imageEvidence.status}; SigLIP rank ${e.retrieval.siglipRank ?? "—"}; ${e.verification.selectionNote}${e.verification.notes.length ? ` (${e.verification.notes.join("; ")})` : ""}`);
  }
  if (r.abstained.length + r.unverified.length === 0) L.push("- none");
  L.push("", "## 8–10. Design explanations, structural differences, product and supplier details", "");
  L.push("_Marketplace-reported facts are as recorded and unverified. Design judgements are AI-derived (GPT-6.1 Sol) and do not establish manufacturer or SKU identity._", "");
  for (const e of [...r.verified, ...r.abstained, ...r.unverified]) {
    const v = e.verification;
    L.push(`### ${v.verificationRank ? `${v.verificationRank}. ` : ""}${cell(e.title)}`, "");
    if (v.summary) L.push(`> ${v.summary}`, "");
    if (v.status === "reused") {
      L.push(
        ...evidenceLines("Matches", v.matches),
        ...evidenceLines("Partial structural differences", v.partialStructuralDifferences),
        ...evidenceLines("Structural mismatches", v.structuralMismatches),
        ...evidenceLines("Appearance differences", v.appearanceDifferences),
        `- **Visibility limitations:** ${v.limitations.join("; ") || "none recorded"}`,
        `- **Uncertain claims:** ${v.uncertainClaims.join("; ") || "none recorded"}`,
      );
    } else {
      L.push(`- **Not visually verified** (${v.status}). ${v.selectionNote}.`);
    }
    L.push(...productLines(e), "");
  }
  L.push("## 11. Image-evidence limitations", "");
  const limited = [...r.verified, ...r.abstained, ...r.unverified].filter((e) => e.imageEvidence.status !== "available" || e.imageEvidence.image?.fallback);
  L.push(...(limited.length ? limited.map((e) => `- ${e.listingId}: ${e.imageEvidence.status}${e.imageEvidence.image?.fallback ? " (fallback image)" : ""}${e.imageEvidence.problems.length ? ` — ${e.imageEvidence.problems.map((p) => `${p.ref}: ${p.problem}`).join("; ")}` : ""}`) : ["- none"]));
  L.push(
    "",
    "## 12. Model and provider provenance",
    "",
    `- SigLIP 2: ${r.models.siglip ? `${r.models.siglip.id} @ ${r.models.siglip.revision} (${r.models.siglip.source})` : "not available"}`,
    `- GPT-6.1 Sol settings: ${r.models.sol.model}, instructions ${r.models.sol.instructionsVersion}, detail ${r.models.sol.imageDetail}, reasoning ${r.models.sol.reasoningEffort}`,
    "",
    "## 13. Recorded usage",
    "",
    `- Reused Sol responses ${r.recordedUsage.solResponses}: input tokens ${r.recordedUsage.inputTokens}, output tokens ${r.recordedUsage.outputTokens} (reasoning ${r.recordedUsage.reasoningTokens}). This run made no requests.`,
    "",
    "## 14. Warnings and failures",
    "",
    ...(r.warnings.length ? r.warnings.map((w) => `- ${w}`) : ["- none"]),
    "",
    "## 15. Recommended follow-up",
    "",
    ...(r.followUps.length ? r.followUps.map((f) => `- ${f}`) : ["- none"]),
    "",
  );
  return L.join("\n");
}
