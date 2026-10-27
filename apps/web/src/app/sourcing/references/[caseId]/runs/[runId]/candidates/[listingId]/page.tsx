import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { EvidenceSections } from "@/components/sourcing/evidence-sections";
import { Badge, Eyebrow, ExternalLink, Icon, Notice } from "@/components/sourcing/primitives";
import { ProductDetails } from "@/components/sourcing/product-details";
import { candidateImageUrl, getRun, LISTING_ID, referenceImageUrl } from "@/lib/sourcing/ui/data";
import {
  caseTitle,
  classificationLabel,
  CLASSIFICATION_LABELS,
  CONFIDENCE_EXPLANATION,
  COSINE_EXPLANATION,
  EVIDENCE_STATUS_TEXT,
  INDEX_EXPLANATION,
  VERIFICATION_STATUS_TEXT,
} from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";

type Params = { params: Promise<{ caseId: string; runId: string; listingId: string }> };

export const metadata: Metadata = { title: "Compare candidate" };

export default async function ComparisonPage({ params }: Params) {
  if (!(await localPageAllowed())) return null;
  const { caseId, runId, listingId: raw } = await params;
  const listingId = decodeURIComponent(raw);
  if (!LISTING_ID.test(listingId)) notFound();
  const run = await getRun(localPaths(), caseId, runId);
  const result = run?.result;
  if (!result) notFound();
  const all = [...result.verified, ...result.abstained, ...result.unverified];
  const entry = all.find((e) => e.listingId === listingId);
  if (!entry) notFound();
  const v = entry.verification;
  const verified = v.status === "reused" && v.designSimilarityIndex !== null;
  const base = `/sourcing/references/${caseId}/runs/${runId}`;
  const order = [...result.verified, ...result.abstained, ...result.unverified];
  const i = order.findIndex((e) => e.listingId === listingId);
  const prev = order[i - 1];
  const next = order[i + 1];

  return (
    <div className="space-y-10">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href={base} className="inline-flex min-h-10 items-center gap-1 text-muted hover:text-ink">
          <Icon name="back" className="h-4 w-4" /> All candidates
        </Link>
        <div className="flex gap-2">
          {prev ? (
            <Link href={`${base}/candidates/${encodeURIComponent(prev.listingId)}`} className="inline-flex min-h-10 items-center gap-1 rounded-full border border-line px-3 text-ink-soft hover:bg-paper">
              <Icon name="back" className="h-4 w-4" /> Previous
            </Link>
          ) : null}
          {next ? (
            <Link href={`${base}/candidates/${encodeURIComponent(next.listingId)}`} className="inline-flex min-h-10 items-center gap-1 rounded-full border border-line px-3 text-ink-soft hover:bg-paper">
              Next <Icon name="forward" className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </nav>

      <header className="space-y-3">
        <Eyebrow>{verified ? `Verification rank ${v.verificationRank} of ${result.verified.length}` : "Not visually verified"}</Eyebrow>
        <h1 className="max-w-4xl font-serif text-3xl leading-tight text-ink sm:text-4xl">{entry.title}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <ExternalLink href={entry.listingUrl}>Open original Alibaba listing</ExternalLink>
          <span className="text-muted">Supplier: {entry.supplier?.name ?? "Not provided"}</span>
          {result.synthetic ? <Badge tone="warn">Synthetic data</Badge> : null}
        </div>
      </header>

      <section aria-labelledby="images">
        <h2 id="images" className="sr-only">
          Photographs
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <EvidenceImage src={referenceImageUrl(caseId)} alt={`Reference photo: ${caseTitle(caseId)}`} label="Reference" priority />
          <EvidenceImage src={entry.imageEvidence.image ? candidateImageUrl(caseId, runId, entry.listingId) : null} alt={`Candidate photo: ${entry.title}`} label="Candidate" priority />
        </div>
        <p className="mt-2 text-xs text-muted">
          Photographs are shown side by side, not aligned or overlaid: camera angle, cropping and room styling differ between them.
          {entry.imageEvidence.image?.fallback ? " The candidate photo is a fallback image (the listing's first-choice image was unusable)." : ""}
        </p>
        {entry.imageEvidence.status !== "available" ? (
          <div className="mt-3">
            <Notice tone="warn" title="No usable candidate photograph">
              {EVIDENCE_STATUS_TEXT[entry.imageEvidence.status] ?? entry.imageEvidence.status}
            </Notice>
          </div>
        ) : null}
      </section>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="assessment" className="space-y-6">
          <div>
            <Eyebrow>AI-derived visual judgement · GPT-6.1 Sol</Eyebrow>
            <h2 id="assessment" className="mt-1 font-serif text-2xl text-ink">
              Design comparison
            </h2>
          </div>
          {verified ? (
            <>
              <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-paper p-5">
                <span className="font-serif text-5xl tabular-nums text-ink" aria-label={`Design index ${v.designSimilarityIndex} of 100`}>
                  {v.designSimilarityIndex}
                  <span className="text-lg text-muted">/100</span>
                </span>
                <div className="space-y-1">
                  <Badge tone={v.classification === "close_variant" || v.classification === "exact_visual_design" ? "ok" : "neutral"} icon="check">
                    {classificationLabel(v.classification)}
                  </Badge>
                  <p className="text-sm text-ink-soft">{v.confidence} confidence in this assessment</p>
                </div>
              </div>
              <div className="space-y-2 text-sm text-muted">
                <p>{INDEX_EXPLANATION}</p>
                <p>{CONFIDENCE_EXPLANATION}</p>
                {v.classification ? <p>{CLASSIFICATION_LABELS[v.classification]?.description}</p> : null}
              </div>
              {v.summary ? <blockquote className="border-l-2 border-accent pl-4 font-serif text-lg leading-relaxed text-ink">{v.summary}</blockquote> : null}
              <EvidenceSections v={v} />
              <p className="text-xs text-muted">
                Assessment by {v.model ?? "unknown model"}, instructions {v.instructionsVersion ?? "unknown"}. Saved record reused; no new request was made to show it.
              </p>
            </>
          ) : (
            <Notice tone="warn" title="Not visually verified">
              {VERIFICATION_STATUS_TEXT[v.status] ?? "No valid assessment exists for this candidate."} No design index is shown, and this is not a judgement that the designs differ.
              {v.notes.length ? <span className="mt-1 block text-xs">{v.notes.join("; ")}</span> : null}
            </Notice>
          )}
          <div className="rounded-xl border border-line bg-paper p-4 text-sm">
            <p className="font-medium text-ink">Retrieval signal (separate)</p>
            <p className="mt-1 text-ink-soft">
              SigLIP 2 rank {entry.retrieval.siglipRank ?? "—"}
              {entry.retrieval.embeddingCosineSimilarity !== null ? `, cosine ${entry.retrieval.embeddingCosineSimilarity.toFixed(4)}` : ""}
            </p>
            <p className="mt-1 text-xs text-muted">{COSINE_EXPLANATION}</p>
          </div>
        </section>

        <section aria-labelledby="product" className="space-y-4">
          <div>
            <Eyebrow>Marketplace-reported</Eyebrow>
            <h2 id="product" className="mt-1 font-serif text-2xl text-ink">
              Product and supplier
            </h2>
          </div>
          <ProductDetails entry={entry} />
        </section>
      </div>
    </div>
  );
}
