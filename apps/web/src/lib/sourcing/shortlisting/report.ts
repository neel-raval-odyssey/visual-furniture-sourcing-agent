import type { RejectedImage, VisualShortlist } from "./types";

/** Readable renderings of a visual shortlist. Neither includes local file paths. */

const score = (v: number) => v.toFixed(4);
const rejections = (r: RejectedImage[]) => r.map((x) => `${x.ref} (${x.problem})`).join("; ");
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function header(s: VisualShortlist): string[] {
  const lines: string[] = [];
  if (s.synthetic) lines.push("SYNTHETIC: contains synthetic data; these are not real Alibaba.com listings.");
  lines.push(`Reference ${s.reference.referenceImageId} (fingerprint ${s.reference.fingerprintId}); image SHA-256 ${s.reference.sha256}`);
  if (s.model && s.device) {
    lines.push(`Model ${s.model.id} @ ${s.model.revision} (${s.model.architecture}, ${s.model.embeddingDim}-d, ${s.model.dtype})`);
    lines.push(`Device ${s.device.type} (requested ${s.device.requested}): ${s.device.reason}`);
  } else {
    lines.push("No model ran: no candidate had a usable local image.");
  }
  lines.push(`Score: embeddingCosineSimilarity, ${s.method.ordering}. Top-K ${s.topK}.`);
  return lines;
}

export function renderShortlistText(s: VisualShortlist): string {
  const lines = [`# Visual shortlist: ${s.caseId}`, ...header(s)];
  lines.push(
    `Listings: ${s.counts.listings}; embedded: ${s.counts.embedded}; shortlisted: ${s.counts.shortlisted}; below top-K: ${s.counts.belowTopK}; excluded: ${s.counts.excluded}.`,
  );
  lines.push("");
  if (s.shortlist.length === 0) lines.push("No candidates were ranked.");
  for (const e of s.shortlist) {
    lines.push(`${e.rank}. cosine ${score(e.embeddingCosineSimilarity)}  ${e.title}`);
    lines.push(`   listing ${e.listingId}${e.marketplaceProductId ? ` (product ${e.marketplaceProductId})` : ""}  ${e.listingUrl}`);
    lines.push(`   supplier: ${e.supplier ? e.supplier.name : "not recorded"}`);
    lines.push(`   image: ${e.image.ref}${e.image.fallback ? " (fallback)" : ""}, ${e.image.format} ${e.image.width}x${e.image.height}, sha256 ${e.image.sha256.slice(0, 16)}…`);
    if (e.rejectedImages.length) lines.push(`   skipped images: ${rejections(e.rejectedImages)}`);
    lines.push(`   visual verification: not assessed`);
  }
  if (s.belowTopK.length) lines.push("", `Ranked below top-K: ${s.belowTopK.join(", ")}`);
  for (const x of s.excluded) {
    lines.push("", `Excluded ${x.listingId} (${x.reason === "no_image" ? "no image recorded" : "no usable image"}): ${x.title}`);
    if (x.rejectedImages.length) lines.push(`   ${rejections(x.rejectedImages)}`);
  }
  lines.push(
    "",
    "Cosine similarity is a retrieval ranking signal, not a confidence, match percentage or verification. No design similarity index, confidence or match classification has been produced.",
  );
  return lines.join("\n");
}

export function renderShortlistMarkdown(s: VisualShortlist): string {
  const lines = [`# Visual shortlist: ${s.caseId}`, "", `Created ${s.createdAt}.`, ""];
  for (const l of header(s)) lines.push(`- ${l}`);
  lines.push(`- Image selection: ${s.imageSelectionPolicy}`);
  if (s.preprocessing) lines.push(`- Preprocessing: \`${JSON.stringify(s.preprocessing)}\``);
  if (s.runtime) lines.push(`- Runtime: ${Object.entries(s.runtime).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push(`- Candidates: operator-assisted capture ${s.candidates.manifestCapturedAt} (${s.candidates.providerId}).`);
  lines.push("", "| Rank | Alibaba product ID | Title | Cosine similarity | Candidate image | Supplier |", "| --- | --- | --- | --- | --- | --- |");
  for (const e of s.shortlist) {
    lines.push(
      `| ${e.rank} | ${e.marketplaceProductId ?? "—"} | [${cell(e.title)}](${e.listingUrl}) | ${score(e.embeddingCosineSimilarity)} | ${cell(e.image.ref)}${e.image.fallback ? " (fallback)" : ""} | ${cell(e.supplier?.name ?? "not recorded")} |`,
    );
  }
  if (s.shortlist.length === 0) lines.push("| — | — | No candidates were ranked | — | — | — |");
  if (s.belowTopK.length) lines.push("", `Ranked below top-K: ${s.belowTopK.join(", ")}.`);
  if (s.excluded.length) {
    lines.push("", "## Excluded listings", "");
    for (const x of s.excluded) {
      lines.push(`- ${x.listingId}: ${x.reason}${x.rejectedImages.length ? ` — ${rejections(x.rejectedImages)}` : ""}`);
    }
  }
  lines.push("", "## Interpretation", "", s.method.interpretation, "", `Visual verification: ${s.visualVerification.note}`, "");
  return lines.join("\n");
}
