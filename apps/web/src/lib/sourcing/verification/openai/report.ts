import type { CandidateListing, MatchClassification, SupplierProfile } from "../../domain";
import type { SavedShortlist } from "../../shortlisting/shortlist-schema";
import type { RecordStatus, VerificationRecord } from "./record";

/**
 * Offline comparison of saved verification records with the saved SigLIP 2
 * shortlist. Reads saved files only; never calls a model. The two signals are
 * shown side by side and never combined, and supplier data is shown for
 * identification only.
 */

export interface VerificationReportEntry {
  listingId: string;
  marketplaceProductId: string | null;
  title: string;
  listingUrl: string;
  supplier: string | null;
  verification: {
    status: RecordStatus | "not_verified";
    /** 1-based, among succeeded records with a non-null index only. */
    verificationRank: number | null;
    designSimilarityIndex: number | null;
    classification: MatchClassification | null;
    confidence: "low" | "medium" | "high" | null;
    keyMatches: string[];
    keyMismatches: string[];
    evidenceGaps: string[];
    summary: string | null;
    error: string | null;
    record: string | null;
    attempts: number;
  };
  shortlist: { siglipRank: number | null; embeddingCosineSimilarity: number | null; note: string | null };
}

export interface VerificationReport {
  recordType: "visual_verification_report";
  schemaVersion: 1;
  caseId: string;
  createdAt: string;
  synthetic: boolean;
  verifier: { model: string; instructionsVersion: string };
  referenceImageId: string;
  fingerprintId: string;
  shortlist: { model: string | null; createdAt: string } | null;
  counts: { listings: number; verified: number; abstained: number; failed: number; notVerified: number };
  /** Every listing: assessed ones by descending design similarity index (ties by listing id), then the rest by listing id. */
  entries: VerificationReportEntry[];
  recordProblems: { file: string; detail: string }[];
  notes: string[];
}

export interface BuildReportInput {
  caseId: string;
  createdAt: string;
  referenceImageId: string;
  fingerprintId: string;
  referenceSha256: string;
  synthetic: boolean;
  listings: readonly CandidateListing[];
  suppliers: readonly SupplierProfile[];
  records: readonly { file: string; record: VerificationRecord }[];
  recordProblems: { file: string; detail: string }[];
  shortlist: SavedShortlist | null;
  model: string;
  instructionsVersion: string;
}

const features = (r: VerificationRecord, pick: (c: string, importance: string) => boolean) =>
  (r.rawVerification?.features ?? []).filter((f) => pick(f.comparison, f.importance)).map((f) => f.feature);

export function buildVerificationReport(input: BuildReportInput): VerificationReport {
  const suppliers = new Map(input.suppliers.map((s) => [s.id, s.name]));
  const shortlisted = new Map((input.shortlist?.shortlist ?? []).map((e) => [e.listingId, e]));
  const excluded = new Map((input.shortlist?.excluded ?? []).map((e) => [e.listingId, e.reason]));
  const below = new Set(input.shortlist?.belowTopK ?? []);

  // Only records for this verifier configuration and this reference image.
  const relevant = input.records.filter(
    ({ record }) =>
      record.request.model === input.model &&
      record.request.instructionsVersion === input.instructionsVersion &&
      record.referenceImage.sha256 === input.referenceSha256 &&
      record.fingerprintId === input.fingerprintId,
  );

  const entries: VerificationReportEntry[] = input.listings.map((listing) => {
    const mine = relevant.filter((r) => r.record.listingId === listing.id).sort((a, b) => (a.record.requestedAt < b.record.requestedAt ? 1 : -1));
    const chosen = mine.find((r) => r.record.status === "succeeded") ?? mine[0];
    const r = chosen?.record;
    const s = shortlisted.get(listing.id);
    return {
      listingId: listing.id,
      marketplaceProductId: listing.marketplaceProductId ?? null,
      title: listing.title,
      listingUrl: listing.listingUrl,
      supplier: listing.supplierId ? (suppliers.get(listing.supplierId) ?? null) : null,
      verification: {
        status: r?.status ?? "not_verified",
        verificationRank: null,
        designSimilarityIndex: r?.assessment?.designSimilarityIndex ?? null,
        classification: r?.assessment?.classification ?? null,
        confidence: r?.assessment?.confidence ?? null,
        keyMatches: r ? features(r, (c, i) => c === "match" && i !== "minor") : [],
        keyMismatches: r ? features(r, (c, i) => c === "mismatch" && i !== "minor") : [],
        evidenceGaps: r?.assessment?.unverifiableFeatures ?? [],
        summary: r?.rawVerification?.summary ?? null,
        error: r?.error ? `${r.error.category}: ${r.error.message}` : r?.status === "requested" ? "no result recorded (interrupted or still running)" : null,
        record: chosen?.file ?? null,
        attempts: mine.length,
      },
      shortlist: {
        siglipRank: s?.rank ?? null,
        embeddingCosineSimilarity: s?.embeddingCosineSimilarity ?? null,
        note: s ? null : excluded.has(listing.id) ? `excluded: ${excluded.get(listing.id)}` : below.has(listing.id) ? "below top-K" : input.shortlist ? "not in shortlist" : "no shortlist",
      },
    };
  });

  const ranked = entries
    .filter((e) => e.verification.status === "succeeded" && e.verification.designSimilarityIndex !== null)
    .sort((a, b) => b.verification.designSimilarityIndex! - a.verification.designSimilarityIndex! || (a.listingId < b.listingId ? -1 : 1));
  ranked.forEach((e, i) => (e.verification.verificationRank = i + 1));
  const rankedIds = new Set(ranked.map((e) => e.listingId));
  const rest = entries.filter((e) => !rankedIds.has(e.listingId)).sort((a, b) => (a.listingId < b.listingId ? -1 : 1));

  const count = (pred: (e: VerificationReportEntry) => boolean) => entries.filter(pred).length;
  return {
    recordType: "visual_verification_report",
    schemaVersion: 1,
    caseId: input.caseId,
    createdAt: input.createdAt,
    synthetic: input.synthetic,
    verifier: { model: input.model, instructionsVersion: input.instructionsVersion },
    referenceImageId: input.referenceImageId,
    fingerprintId: input.fingerprintId,
    shortlist: input.shortlist ? { model: input.shortlist.model?.id ?? null, createdAt: input.shortlist.createdAt } : null,
    counts: {
      listings: entries.length,
      verified: ranked.length,
      abstained: count((e) => e.verification.status === "succeeded" && e.verification.designSimilarityIndex === null),
      failed: count((e) => !["succeeded", "not_verified"].includes(e.verification.status)),
      notVerified: count((e) => e.verification.status === "not_verified"),
    },
    entries: [...ranked, ...rest],
    recordProblems: input.recordProblems,
    notes: [
      "Verification rank orders assessed candidates by the model's design similarity index (a qualitative 0-100 judgement, not a probability). Unassessed, abstained and failed candidates are listed without a rank and never scored 0.",
      "SigLIP rank and cosine are independent retrieval results from the saved shortlist; they were not shown to the verifier and are not combined with the verification.",
      "Supplier names identify listings only; they play no part in either signal.",
    ],
  };
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const list = (items: string[]) => (items.length ? items.join(", ") : "—");

export function renderVerificationReportMarkdown(r: VerificationReport): string {
  const lines = [`# Visual verification report: ${r.caseId}`, "", `Created ${r.createdAt} from saved records only.`, ""];
  if (r.synthetic) lines.push("**SYNTHETIC:** contains synthetic data; these are not real Alibaba.com listings.", "");
  lines.push(
    `- Verifier: ${r.verifier.model}, instructions ${r.verifier.instructionsVersion}`,
    `- Reference ${r.referenceImageId}, fingerprint ${r.fingerprintId}`,
    `- Shortlist: ${r.shortlist ? `${r.shortlist.model ?? "no model"} (${r.shortlist.createdAt})` : "none"}`,
    `- Listings ${r.counts.listings}; verified ${r.counts.verified}; abstained ${r.counts.abstained}; failed ${r.counts.failed}; not verified ${r.counts.notVerified}`,
    "",
    "| Verification rank | Product ID | Sol index | Classification | Confidence | Status | SigLIP rank | Cosine | Supplier |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const e of r.entries) {
    const v = e.verification;
    lines.push(
      `| ${v.verificationRank ?? "unranked"} | [${e.marketplaceProductId ?? e.listingId}](${e.listingUrl}) | ${v.designSimilarityIndex ?? "—"} | ${v.classification ?? "—"} | ${v.confidence ?? "—"} | ${v.status} | ${e.shortlist.siglipRank ?? "—"} | ${e.shortlist.embeddingCosineSimilarity?.toFixed(4) ?? "—"} | ${cell(e.supplier ?? "not recorded")} |`,
    );
  }
  lines.push("", "## Evidence", "");
  for (const e of r.entries) {
    const v = e.verification;
    lines.push(`### ${e.marketplaceProductId ?? e.listingId}: ${cell(e.title)}`, "");
    if (v.summary) lines.push(v.summary, "");
    lines.push(`- Key matches: ${list(v.keyMatches)}`, `- Key mismatches: ${list(v.keyMismatches)}`, `- Evidence gaps: ${list(v.evidenceGaps)}`);
    if (v.error) lines.push(`- Problem: ${v.error}`);
    lines.push(`- Attempts recorded: ${v.attempts}${v.record ? ` (shown: ${v.record})` : ""}`, "");
  }
  if (r.recordProblems.length) {
    lines.push("## Unreadable records", "", ...r.recordProblems.map((p) => `- ${p.file}: ${p.detail}`), "");
  }
  lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}
