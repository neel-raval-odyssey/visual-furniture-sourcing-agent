import type { EvidenceItem, SourcingEntry, SourcingResult } from "../orchestration/assemble";
import { listReferences, type Paths } from "./data";
import { caseTitle, formatMoq, formatPrice, humanize, type Tone } from "./labels";

/**
 * Plain-English view models for the simple sourcing experience. Everything is
 * selected from the saved SourcingResult as recorded: observations are quoted,
 * never rewritten, and nothing here changes or combines a score or an order.
 */

export interface FeaturedExample {
  caseId: string;
  runId: string;
  title: string;
  photoUrl: string | null;
  synthetic: boolean;
  candidates: number;
  compared: number;
}

/**
 * The saved example the start screen offers: a genuine reference whose latest
 * run has a readable result (most compared products first). Synthetic cases
 * are used only when no genuine one exists, and are labelled as such.
 */
export async function getFeaturedExample(paths: Paths): Promise<FeaturedExample | null> {
  const options: FeaturedExample[] = [];
  for (const ref of await listReferences(paths)) {
    const run = ref.runs.find((r) => r.result.available && r.result.counts);
    if (!run || !run.result.counts) continue;
    options.push({
      caseId: ref.caseId,
      runId: run.runId,
      title: caseTitle(ref.caseId),
      photoUrl: ref.photo.url,
      synthetic: ref.synthetic || run.synthetic,
      candidates: run.result.counts.candidates,
      compared: run.result.counts.verified,
    });
  }
  options.sort((a, b) => Number(a.synthetic) - Number(b.synthetic) || b.compared - a.compared || (a.caseId < b.caseId ? -1 : 1));
  return options[0] ?? null;
}

export const resultsHref = (caseId: string, runId: string) => `/sourcing/results/${caseId}/${runId}`;
export const compareHref = (caseId: string, runId: string, listingId: string) => `${resultsHref(caseId, runId)}/compare/${encodeURIComponent(listingId)}`;

export interface Verdict {
  label: string;
  tone: Tone;
  sentence: string;
  /** True only when a saved assessment with a design index exists. */
  compared: boolean;
}

const CLASSIFICATION_VERDICT: Record<string, Omit<Verdict, "compared">> = {
  exact_visual_design: { label: "Very close design", tone: "ok", sentence: "The defining design details match in these photos. This does not mean it is the same product or the same maker." },
  close_variant: { label: "Close design", tone: "ok", sentence: "The same design idea, with some differences in the details." },
  similar_alternative: { label: "Similar alternative", tone: "accent", sentence: "A similar style, but some defining design details differ." },
  non_match: { label: "Different design", tone: "neutral", sentence: "The design differs from the original." },
  insufficient_evidence: { label: "Not enough detail", tone: "warn", sentence: "The photos don't show enough to compare the designs." },
};

/** Why a product has no comparison, in plain words. */
export function notComparedReason(e: SourcingEntry): string {
  switch (e.imageEvidence.status) {
    case "available":
      break;
    case "remote_only":
      return "Only a link to the listing photo was saved, so this product hasn't been compared yet.";
    case "no_image":
    case "missing_file":
      return "There is no saved product photo, so this product can't be compared.";
    default:
      return "The saved product photo couldn't be used, so this product can't be compared.";
  }
  switch (e.verification.status) {
    case "stale":
      return "The saved comparison was made with different photos, so it isn't shown.";
    case "failed":
    case "interrupted":
      return "The comparison for this product didn't finish.";
    case "ambiguous":
      return "The saved comparisons for this product disagree, so none is shown.";
    default:
      return "This product hasn't been compared yet.";
  }
}

export function plainVerdict(e: SourcingEntry): Verdict {
  const v = e.verification;
  const known = v.status === "reused" && v.classification ? CLASSIFICATION_VERDICT[v.classification] : undefined;
  if (known && (v.designSimilarityIndex !== null || v.classification === "insufficient_evidence")) {
    return { ...known, compared: v.designSimilarityIndex !== null };
  }
  return { label: "Not yet compared", tone: "neutral", sentence: notComparedReason(e), compared: false };
}

const IMPORTANCE: Record<string, number> = { defining: 0, supporting: 1, minor: 2 };
const importance = (i: EvidenceItem) => IMPORTANCE[i.importance] ?? 3;
const isAppearance = (i: EvidenceItem) => i.aspect === "surface_appearance";

export interface Similarity {
  feature: string;
  detail: string | null;
}

/** Shared features, most defining first and structure before finish. */
export function similarities(v: SourcingEntry["verification"], max = 3): Similarity[] {
  return [...v.matches]
    .sort((a, b) => Number(isAppearance(a)) - Number(isAppearance(b)) || importance(a) - importance(b))
    .slice(0, max)
    .map((i) => ({ feature: humanize(i.feature), detail: i.candidate ?? i.reference }));
}

export type DifferenceKind = "partial" | "mismatch" | "appearance";

export interface Difference {
  feature: string;
  kind: DifferenceKind;
  original: string | null;
  candidate: string | null;
}

export const DIFFERENCE_KIND_LABELS: Record<DifferenceKind, string> = {
  partial: "Similar, but not the same",
  mismatch: "Different",
  appearance: "Colour or finish",
};

/**
 * Recorded differences, ordered so that defining structural details (such as a
 * different number of headboard arches) come before minor colour or finish.
 */
export function differences(v: SourcingEntry["verification"], max = 3): Difference[] {
  const kindOrder: Record<DifferenceKind, number> = { partial: 0, mismatch: 1, appearance: 2 };
  return [
    ...v.partialStructuralDifferences.map((i) => ({ i, kind: "partial" as const })),
    ...v.structuralMismatches.map((i) => ({ i, kind: "mismatch" as const })),
    ...v.appearanceDifferences.map((i) => ({ i, kind: "appearance" as const })),
  ]
    .sort(
      (a, b) =>
        Number(a.kind === "appearance" || isAppearance(a.i)) - Number(b.kind === "appearance" || isAppearance(b.i)) ||
        importance(a.i) - importance(b.i) ||
        kindOrder[a.kind] - kindOrder[b.kind],
    )
    .slice(0, max)
    .map(({ i, kind }) => ({ feature: humanize(i.feature), kind, original: i.reference, candidate: i.candidate }));
}

/** The single most important recorded difference, or null when none was recorded. */
export const keyDifference = (v: SourcingEntry["verification"]) => differences(v, 1)[0] ?? null;

/**
 * A short display name from a long marketplace title: the part before a
 * separator or "with …", cut at a word boundary. The full title stays available.
 */
export function shortTitle(title: string, max = 52): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const head = clean.split(/\s+(?:with|for)\s+|\s[|–-]\s|,/i)[0];
  const base = head.length >= 16 ? head : clean;
  if (base.length <= max) return base;
  const cut = base.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : base.slice(0, max)).replace(/[\s,;:–-]+$/, "")}…`;
}

/** Price and minimum order on one line, always qualified as marketplace-reported. */
export function listedTerms(e: SourcingEntry): string {
  const price = e.product.price ? formatPrice(e.product.price) : "Price not listed";
  const moq = e.product.minimumOrder ? `min. order ${formatMoq(e.product.minimumOrder)}` : "minimum order not listed";
  return `${price} · ${moq} · as listed`;
}

/** Grid columns that keep a row balanced (no single card left alone where avoidable). */
export function balancedColumns(count: number): string {
  if (count === 3) return "sm:grid-cols-3";
  if (count === 2 || count === 4) return "sm:grid-cols-2";
  return "sm:grid-cols-2 lg:grid-cols-3";
}

export interface SimpleResults {
  top: SourcingEntry | null;
  others: SourcingEntry[];
  notCompared: SourcingEntry[];
}

/** Splits a result in its recorded verification order; unassessed products stay separate. */
export function splitResults(result: SourcingResult): SimpleResults {
  const [top, ...others] = result.verified;
  return { top: top ?? null, others, notCompared: [...result.abstained, ...result.unverified] };
}
