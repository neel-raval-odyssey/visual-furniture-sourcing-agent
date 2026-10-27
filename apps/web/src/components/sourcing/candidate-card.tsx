import Link from "next/link";
import type { SourcingEntry } from "@/lib/sourcing/orchestration/assemble";
import { classificationLabel, formatMoq, formatPrice, VERIFICATION_STATUS_TEXT } from "@/lib/sourcing/ui/labels";
import { EvidenceImage } from "./evidence-image";
import { keyDifferences } from "./evidence-sections";
import { Badge, ExternalLink, Icon } from "./primitives";

/** One candidate in the results list. Unverified candidates show no index at all. */
export function CandidateCard({ entry, imageUrl, href }: { entry: SourcingEntry; imageUrl: string | null; href: string }) {
  const v = entry.verification;
  const verified = v.status === "reused" && v.designSimilarityIndex !== null;
  const diffs = verified ? keyDifferences(v, 2) : [];
  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_1px_0_rgba(30,28,25,0.04)] transition-shadow hover:shadow-md">
      <EvidenceImage src={imageUrl} alt={`Candidate product photo: ${entry.title}`} zoomable={false} aspect="aspect-[4/3]" fit="cover" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {verified ? (
            <>
              <span className="rounded-md bg-ink px-2 py-0.5 text-sm font-semibold tabular-nums text-paper" aria-label={`Design index ${v.designSimilarityIndex} of 100`}>
                {v.designSimilarityIndex}
              </span>
              <Badge tone={v.classification === "close_variant" || v.classification === "exact_visual_design" ? "ok" : "neutral"} icon="check">
                {classificationLabel(v.classification)}
              </Badge>
              <span className="text-xs text-muted">{v.confidence} confidence</span>
            </>
          ) : (
            <Badge tone="warn">{VERIFICATION_STATUS_TEXT[v.status] ?? "Not visually verified"}</Badge>
          )}
        </div>
        <h3 className="line-clamp-2 font-medium leading-snug text-ink">{entry.title}</h3>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Supplier</dt>
          <dd className="truncate text-ink-soft">{entry.supplier?.name ?? "Not provided"}</dd>
          <dt className="text-muted">Price</dt>
          <dd className="text-ink-soft">{formatPrice(entry.product.price)}</dd>
          <dt className="text-muted">MOQ</dt>
          <dd className="text-ink-soft">{formatMoq(entry.product.minimumOrder)}</dd>
        </dl>
        {diffs.length ? (
          <ul className="space-y-1 text-sm text-ink-soft">
            {diffs.map((d, i) => (
              <li key={i} className="flex gap-1.5">
                <Icon name={d.kind === "partial" ? "partial" : "x"} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${d.kind === "partial" ? "text-warn" : "text-bad"}`} />
                <span className="line-clamp-2">
                  <span className="sr-only">{d.kind === "partial" ? "Partial difference: " : "Mismatch: "}</span>
                  {d.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm">
          <Link href={href} className="inline-flex min-h-10 items-center gap-1 font-medium text-ink underline-offset-4 hover:underline">
            {verified ? "Compare in detail" : "View details"}
            <Icon name="forward" className="h-4 w-4" />
            <span className="sr-only">: {entry.title}</span>
          </Link>
          <ExternalLink href={entry.listingUrl}>Alibaba listing</ExternalLink>
        </div>
        <p className="text-xs text-muted">
          SigLIP retrieval rank {entry.retrieval.siglipRank ?? "—"}
          {entry.retrieval.embeddingCosineSimilarity !== null ? ` · cosine ${entry.retrieval.embeddingCosineSimilarity.toFixed(4)}` : ""}
        </p>
      </div>
    </article>
  );
}
