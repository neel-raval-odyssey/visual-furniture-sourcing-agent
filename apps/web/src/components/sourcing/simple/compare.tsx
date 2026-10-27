import Link from "next/link";
import type { SourcingEntry, SourcingResult } from "@/lib/sourcing/orchestration/assemble";
import { candidateImageUrl, referenceImageUrl } from "@/lib/sourcing/ui/data";
import {
  caseTitle,
  classificationLabel,
  CLASSIFICATION_LABELS,
  CONFIDENCE_EXPLANATION,
  COSINE_EXPLANATION,
  INDEX_EXPLANATION,
  VERIFICATION_STATUS_TEXT,
} from "@/lib/sourcing/ui/labels";
import { compareHref, differences, keyDifference, listedTerms, plainVerdict, resultsHref, shortTitle, similarities } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { EvidenceSections } from "../evidence-sections";
import { Badge, Icon } from "../primitives";
import { ProductDetails } from "../product-details";
import { DifferenceNote, Disclosure } from "./parts";

const navLink = "inline-flex min-h-11 items-center gap-1 rounded-full border border-line px-4 text-sm text-ink-soft hover:border-ink hover:text-ink";

/**
 * Compare designs: the two photographs side by side with a short verdict and
 * the most important difference; similarities and differences quoted from the
 * saved assessment; the full evidence behind disclosures.
 */
export function SimpleCompareView({ caseId, runId, result, entry }: { caseId: string; runId: string; result: SourcingResult; entry: SourcingEntry }) {
  const order = [...result.verified, ...result.abstained, ...result.unverified];
  const i = order.findIndex((e) => e.listingId === entry.listingId);
  const prev = order[i - 1];
  const next = order[i + 1];
  const verdict = plainVerdict(entry);
  const v = entry.verification;
  const name = shortTitle(entry.title);
  const diff = verdict.compared ? keyDifference(v) : null;
  const alike = verdict.compared ? similarities(v, 3) : [];
  const unlike = verdict.compared ? differences(v, 3) : [];

  return (
    <div className="space-y-10">
      <nav aria-label="Results navigation" className="flex flex-wrap items-center justify-between gap-3">
        <Link href={resultsHref(caseId, runId)} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" className="h-4 w-4" /> Back to results
        </Link>
        <div className="flex items-center gap-2">
          <span className="mr-1 text-sm text-muted">
            Design {i + 1} of {order.length}
          </span>
          {prev ? (
            <Link href={compareHref(caseId, runId, prev.listingId)} className={navLink}>
              <Icon name="back" className="h-4 w-4" /> Previous
            </Link>
          ) : null}
          {next ? (
            <Link href={compareHref(caseId, runId, next.listingId)} className={navLink}>
              Next <Icon name="forward" className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </nav>

      <section aria-labelledby="compare-title" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="grid grid-cols-2 gap-2 sm:gap-4 lg:col-span-2">
          <EvidenceImage src={referenceImageUrl(caseId)} alt={`Original furniture photo: ${caseTitle(caseId)}`} label="Original" priority aspect="aspect-square sm:aspect-[4/3]" />
          <EvidenceImage src={entry.imageEvidence.image ? candidateImageUrl(caseId, runId, entry.listingId) : null} alt={`Product photo: ${name}`} label="This design" priority aspect="aspect-square sm:aspect-[4/3]" />
        </div>
        <div className="flex flex-col gap-4">
          <h1 id="compare-title" className="font-serif text-2xl leading-tight text-ink sm:text-3xl" title={entry.title}>
            {name}
          </h1>
          <div className="space-y-2">
            <Badge tone={verdict.tone} icon={verdict.compared ? "check" : "minus"}>
              {verdict.label}
            </Badge>
            <p className="text-ink-soft">{verdict.sentence}</p>
          </div>
          {diff ? (
            <div className="rounded-xl border border-warn/25 bg-warn-soft/60 p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Icon name="partial" className="h-4 w-4 text-warn" /> Most important difference
              </p>
              <DifferenceNote d={diff} compact />
            </div>
          ) : null}
          <div className="space-y-1 text-sm">
            <p>
              <span className="text-muted">Supplier: </span>
              <span className="text-ink">{entry.supplier?.name ?? "Not listed"}</span>
            </p>
            <p className="text-xs text-muted">{listedTerms(entry)}</p>
          </div>
          <a
            href={entry.listingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 font-medium text-paper hover:bg-ink-soft"
          >
            View on Alibaba <Icon name="external" className="h-4 w-4" />
            <span className="sr-only">(opens the original listing in a new tab)</span>
          </a>
        </div>
      </section>

      {verdict.compared ? (
        <section aria-label="Similarities and differences" className="grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-paper p-5">
            <h2 className="flex items-center gap-2 font-serif text-xl text-ink">
              <Icon name="check" className="h-5 w-5 text-ok" /> What looks similar
            </h2>
            {alike.length ? (
              <ul className="mt-3 space-y-3">
                {alike.map((s, k) => (
                  <li key={k}>
                    <p className="font-medium text-ink">{s.feature}</p>
                    <p className="text-sm text-ink-soft">{s.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted">No shared features were recorded.</p>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-paper p-5">
            <h2 className="flex items-center gap-2 font-serif text-xl text-ink">
              <Icon name="partial" className="h-5 w-5 text-warn" /> What&apos;s different
            </h2>
            {unlike.length ? (
              <ul className="mt-3 space-y-4">
                {unlike.map((d, k) => (
                  <li key={k}>
                    <DifferenceNote d={d} compact />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted">No differences were recorded.</p>
            )}
          </div>
        </section>
      ) : null}

      <div className="space-y-3">
        <Disclosure title="See detailed comparison" hint="Every recorded observation, limitations and how this was assessed">
          <div className="space-y-6">
            {verdict.compared ? (
              <div className="space-y-2 text-sm text-ink-soft">
                <p>
                  <span className="font-medium text-ink">Design index {v.designSimilarityIndex}/100</span> · {classificationLabel(v.classification)} · {v.confidence} confidence
                </p>
                <p>{INDEX_EXPLANATION}</p>
                {v.classification ? <p>{CLASSIFICATION_LABELS[v.classification]?.description}</p> : null}
                <p>{CONFIDENCE_EXPLANATION}</p>
                {v.summary ? <blockquote className="border-l-2 border-accent pl-4 font-serif text-base text-ink">{v.summary}</blockquote> : null}
              </div>
            ) : (
              <p className="text-sm text-ink-soft">{VERIFICATION_STATUS_TEXT[v.status] ?? "No valid assessment exists for this candidate."}</p>
            )}
            {verdict.compared ? <EvidenceSections v={v} /> : null}
            <div className="space-y-1 text-sm text-ink-soft">
              <p>
                Retrieval: SigLIP 2 rank {entry.retrieval.siglipRank ?? "—"}
                {entry.retrieval.embeddingCosineSimilarity !== null ? `, cosine ${entry.retrieval.embeddingCosineSimilarity.toFixed(4)}` : ""}. {COSINE_EXPLANATION}
              </p>
              {verdict.compared ? (
                <p>
                  Assessment by {v.model ?? "unknown model"}, instructions {v.instructionsVersion ?? "unknown"}. Saved record reused; no new request was made to show it.
                </p>
              ) : null}
              <Link
                href={`/sourcing/references/${caseId}/runs/${runId}/candidates/${encodeURIComponent(entry.listingId)}`}
                className="inline-flex min-h-10 items-center gap-1 font-medium text-accent underline-offset-4 hover:underline"
              >
                Open in the advanced workspace <Icon name="forward" className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </Disclosure>
        <Disclosure title="Product and supplier details" hint="Price tiers, seller information and listing details, as listed">
          <ProductDetails entry={entry} />
        </Disclosure>
        <p className="text-xs text-muted">
          Photos are shown side by side, not overlaid; camera angle and styling differ. Use “View full size” on either photo to look closely.
        </p>
      </div>
    </div>
  );
}
