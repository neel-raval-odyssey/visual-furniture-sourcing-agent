/**
 * Presentation vocabulary for the sourcing interface: maps recorded states and
 * model labels to plain language. Pure functions (safe in server and client
 * components); nothing here changes or interprets a score.
 */

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral" | "accent";

export const STAGE_LABELS: Record<string, string> = {
  reference: "Reference understanding",
  candidates: "Candidate discovery / intake",
  image_evidence: "Image evidence validation",
  shortlist: "SigLIP 2 shortlisting",
  verification: "Sol visual verification",
  assembly: "Result assembly",
};

export const STATE_LABELS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: "Completed", tone: "ok" },
  reused: { label: "Reused saved result", tone: "ok" },
  running: { label: "Running", tone: "info" },
  partial: { label: "Partial", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Skipped", tone: "neutral" },
  not_started: { label: "Not started", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "warn" },
  invalid: { label: "Unreadable record", tone: "bad" },
};

export const stateLabel = (state: string) => STATE_LABELS[state] ?? { label: state.replace(/_/g, " "), tone: "neutral" as Tone };

export const RUN_STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: "Complete", tone: "ok" },
  partial: { label: "Partial result", tone: "warn" },
  running: { label: "Running", tone: "info" },
  blocked: { label: "Blocked", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
  interrupted: { label: "Interrupted", tone: "warn" },
  invalid: { label: "Unreadable", tone: "bad" },
};

export const READINESS_LABELS: Record<string, { label: string; tone: Tone; description: string }> = {
  results_available: { label: "Sourcing results available", tone: "ok", description: "A saved sourcing run with a consolidated result exists." },
  ready_for_offline_run: { label: "Ready for an offline run", tone: "info", description: "A fingerprint and a completed candidate set exist; no result has been assembled yet." },
  no_candidates: { label: "No candidates collected", tone: "neutral", description: "The furniture was understood, but no marketplace candidates have been collected for it." },
  not_identified: { label: "Not identified as furniture", tone: "warn", description: "The saved image-understanding run did not produce a furniture fingerprint." },
  unavailable: { label: "No saved analysis", tone: "neutral", description: "There is no saved image-understanding record for this reference." },
};

export const CLASSIFICATION_LABELS: Record<string, { label: string; description: string }> = {
  exact_visual_design: { label: "Same visual design", description: "The defining features match with no observed defining mismatch. Not a claim of the same manufacturer or product." },
  close_variant: { label: "Close variant", description: "The same design idea with small differences in a few features." },
  similar_alternative: { label: "Similar alternative", description: "Shares style or some features, but at least one defining structural feature differs." },
  non_match: { label: "Different design", description: "A different design or category." },
  insufficient_evidence: { label: "Insufficient evidence", description: "The photographs did not show enough to judge." },
};

export const classificationLabel = (c: string | null) => (c ? (CLASSIFICATION_LABELS[c]?.label ?? c.replace(/_/g, " ")) : "Not visually verified");

export const CONFIDENCE_EXPLANATION =
  "Confidence describes how well the visible photographic evidence supports this visual assessment. It is not supplier reliability and not the probability of an identical product.";

export const INDEX_EXPLANATION =
  "The design index (0–100) is GPT-6.1 Sol's qualitative judgement of how similar the visible designs are. It is not a probability, not a calibrated accuracy, and not proof of the same manufacturer. Small differences between indices are not meaningful on their own.";

export const COSINE_EXPLANATION =
  "SigLIP 2 cosine similarity compares whole images and is used only to retrieve and order candidates for review. It is shown separately and never combined with the design index.";

export const VERIFICATION_STATUS_TEXT: Record<string, string> = {
  reused: "Visually verified (saved assessment)",
  not_eligible: "Not visually verified: no usable image",
  missing: "Not visually verified yet",
  stale: "Not visually verified: saved assessment is for different inputs",
  failed: "Not visually verified: the previous attempt failed",
  interrupted: "Not visually verified: the previous attempt was interrupted",
  ambiguous: "Not visually verified: several conflicting saved assessments",
};

export const EVIDENCE_STATUS_TEXT: Record<string, string> = {
  available: "Local photograph available",
  remote_only: "Only a marketplace image link was recorded. This product is listed but cannot be visually compared until an approved image download is made.",
  no_image: "No image was recorded. This product can still be listed, but it cannot be visually compared.",
  missing_file: "Candidate image missing. This product can still be listed, but it cannot be visually compared.",
  corrupt: "The candidate image appears corrupted, so it cannot be visually compared.",
  unsupported_format: "The candidate image format is not supported for comparison.",
  too_large: "The candidate image exceeds the size limit for comparison.",
  rejected_security: "The candidate image was rejected by the file-safety checks.",
  unreadable: "The candidate image could not be read.",
};

export function formatPrice(price: { min: number; max: number | null; currency: string | null; unit: string | null } | null): string {
  if (!price) return "Not provided";
  const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  const range = price.max !== null && price.max !== price.min ? `${fmt(price.min)}–${fmt(price.max)}` : fmt(price.min);
  return `${price.currency ? `${price.currency} ` : ""}${range}${price.currency ? "" : " (currency not provided)"}${price.unit ? ` per ${price.unit}` : ""}`;
}

export function formatMoq(moq: { quantity: number; unit: string | null } | null): string {
  return moq ? `${moq.quantity.toLocaleString("en-GB")}${moq.unit ? ` ${moq.unit}${moq.quantity === 1 ? "" : "s"}` : ""}` : "Not provided";
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** "ettrick-bed" → "Ettrick bed" (case ids are slugs). */
export const caseTitle = (caseId: string) => humanize(caseId.replace(/-/g, " "));
