import Link from "next/link";
import type { SourcingEntry, SourcingResult } from "@/lib/sourcing/orchestration/assemble";
import { candidateImageUrl, referenceImageUrl } from "@/lib/sourcing/ui/data";
import { caseTitle, classificationLabel, CONFIDENCE_EXPLANATION, COSINE_EXPLANATION, INDEX_EXPLANATION } from "@/lib/sourcing/ui/labels";
import { balancedColumns, compareHref, keyDifference, listedTerms, plainVerdict, shortTitle, similarities, splitResults } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Badge, ExternalLink, Icon, Notice } from "../primitives";
import { DifferenceNote, Disclosure, PrimaryLink, ProductCard, SavedExampleNote } from "./parts";

/**
 * Simple results: the closest saved design first, the rest in a balanced grid,
 * products without a comparison kept separate. Order is the recorded
 * verification order; scores and model details live behind "Technical details".
 */
export function SimpleResultsView({ caseId, runId, result }: { caseId: string; runId: string; result: SourcingResult | null }) {
  const imageOf = (e: SourcingEntry) => (e.imageEvidence.image ? candidateImageUrl(caseId, runId, e.listingId) : null);
  const split = result ? splitResults(result) : null;
  const top = split?.top ?? null;
  const name = caseTitle(caseId);

  return (
    <div className="space-y-14">
      <Link href="/sourcing" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Start
      </Link>

      <header className="grid items-center gap-8 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <p className="text-sm font-medium text-accent">Saved example · {name}</p>
          <h1 className="font-serif text-4xl leading-tight text-ink sm:text-5xl">Similar furniture we found</h1>
          <p className="text-lg text-ink-soft">Here are the closest designs from the products reviewed.</p>
          <SavedExampleNote synthetic={result?.synthetic} />
        </div>
        <EvidenceImage src={referenceImageUrl(caseId)} alt={`Original furniture photo: ${name}`} label="Original" priority />
      </header>

      {!result || !split ? (
        <Notice tone="neutral" title="No saved results for this photo yet">
          Nothing has been found or compared for this photo, so there is nothing to show here.
        </Notice>
      ) : !top && split.notCompared.length === 0 ? (
        <Notice tone="neutral" title="No similar products were saved">
          No products were reviewed for this photo.
        </Notice>
      ) : null}

      {top ? <FeaturedResult entry={top} imageUrl={imageOf(top)} href={compareHref(caseId, runId, top.listingId)} /> : null}

      {split && !top && split.notCompared.length ? (
        <Notice tone="neutral" title="None of the saved products has been compared yet">
          They are listed below, unranked.
        </Notice>
      ) : null}

      {split?.others.length ? (
        <section aria-labelledby="more" className="space-y-5">
          <h2 id="more" className="font-serif text-2xl text-ink sm:text-3xl">
            Other similar designs
          </h2>
          <ol className={`grid gap-5 ${balancedColumns(split.others.length)}`}>
            {split.others.map((e) => (
              <li key={e.listingId}>
                <ProductCard entry={e} imageUrl={imageOf(e)} href={compareHref(caseId, runId, e.listingId)} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {split?.notCompared.length ? (
        <section aria-labelledby="not-compared" className="space-y-5">
          <div>
            <h2 id="not-compared" className="font-serif text-2xl text-ink sm:text-3xl">
              Not yet compared
            </h2>
            <p className="mt-1 text-ink-soft">These products were found but haven&apos;t been compared with the original, so they aren&apos;t ranked.</p>
          </div>
          <ul className={`grid gap-5 ${balancedColumns(split.notCompared.length)}`}>
            {split.notCompared.map((e) => (
              <li key={e.listingId}>
                <ProductCard entry={e} imageUrl={imageOf(e)} href={compareHref(caseId, runId, e.listingId)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result ? <TechnicalDetails caseId={caseId} runId={runId} result={result} /> : null}
    </div>
  );
}

function FeaturedResult({ entry, imageUrl, href }: { entry: SourcingEntry; imageUrl: string | null; href: string }) {
  const verdict = plainVerdict(entry);
  const reasons = similarities(entry.verification, 2);
  const diff = keyDifference(entry.verification);
  const name = shortTitle(entry.title);
  return (
    <section aria-labelledby="closest" className="grid gap-6 rounded-3xl border border-line bg-paper p-4 sm:p-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10 lg:p-8">
      <EvidenceImage src={imageUrl} alt={`Product photo: ${name}`} label="Closest design found" priority />
      <div className="flex flex-col gap-5">
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.12em] text-accent">Closest design found</p>
          <h2 id="closest" className="font-serif text-3xl leading-tight text-ink" title={entry.title}>
            {name}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={verdict.tone} icon="check">
              {verdict.label}
            </Badge>
            <span className="text-sm text-ink-soft">{verdict.sentence}</span>
          </div>
        </div>
        {reasons.length ? (
          <div>
            <h3 className="flex items-center gap-1.5 font-medium text-ink">
              <Icon name="check" className="h-4 w-4 text-ok" /> Why it looks similar
            </h3>
            <ul className="mt-2 space-y-2 text-ink-soft">
              {reasons.map((r, i) => (
                <li key={i}>
                  <span className="font-medium text-ink">{r.feature}.</span> {r.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {diff ? (
          <div className="rounded-xl border border-warn/25 bg-warn-soft/60 p-4">
            <h3 className="mb-2 flex items-center gap-1.5 font-medium text-ink">
              <Icon name="partial" className="h-4 w-4 text-warn" /> Most important difference
            </h3>
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
        <div className="mt-auto flex flex-wrap items-center gap-4">
          <PrimaryLink href={href}>
            Compare designs <Icon name="forward" className="h-5 w-5" />
          </PrimaryLink>
          <ExternalLink href={entry.listingUrl}>View on Alibaba</ExternalLink>
        </div>
      </div>
    </section>
  );
}

/** Scores, retrieval signals and provenance, for readers who want them; never on the main view. */
function TechnicalDetails({ caseId, runId, result }: { caseId: string; runId: string; result: SourcingResult }) {
  const all = [...result.verified, ...result.abstained, ...result.unverified];
  return (
    <Disclosure title="Technical details" hint="Scores, model information and the full research view">
      <div className="space-y-4 text-sm text-ink-soft">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Product</th>
                <th className="py-2 pr-3 font-medium">Sol rank</th>
                <th className="py-2 pr-3 font-medium">Design index</th>
                <th className="py-2 pr-3 font-medium">Classification · confidence</th>
                <th className="py-2 font-medium">SigLIP rank · cosine</th>
              </tr>
            </thead>
            <tbody>
              {all.map((e) => (
                <tr key={e.listingId} className="border-t border-line">
                  <td className="py-2 pr-3">{e.marketplaceProductId ?? e.listingId}</td>
                  <td className="py-2 pr-3">{e.verification.verificationRank ?? "—"}</td>
                  <td className="py-2 pr-3">{e.verification.designSimilarityIndex !== null ? `${e.verification.designSimilarityIndex}/100` : "Not assessed"}</td>
                  <td className="py-2 pr-3">
                    {classificationLabel(e.verification.classification)}
                    {e.verification.confidence ? ` · ${e.verification.confidence}` : ""}
                  </td>
                  <td className="py-2">
                    {e.retrieval.siglipRank ?? "—"}
                    {e.retrieval.embeddingCosineSimilarity !== null ? ` · ${e.retrieval.embeddingCosineSimilarity.toFixed(4)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{INDEX_EXPLANATION}</p>
        <p>{CONFIDENCE_EXPLANATION}</p>
        <p>{COSINE_EXPLANATION}</p>
        <p>
          Verification: {result.models.sol.model}, instructions {result.models.sol.instructionsVersion}. Retrieval: {result.models.siglip ? result.models.siglip.id : "none"}. Run {runId}. Saved assessments were reused; no new request was made to show this page.
        </p>
        <Link href={`/sourcing/references/${caseId}/runs/${runId}`} className="inline-flex min-h-10 items-center gap-1 font-medium text-accent underline-offset-4 hover:underline">
          Open this run in the advanced workspace <Icon name="forward" className="h-4 w-4" />
        </Link>
      </div>
    </Disclosure>
  );
}
