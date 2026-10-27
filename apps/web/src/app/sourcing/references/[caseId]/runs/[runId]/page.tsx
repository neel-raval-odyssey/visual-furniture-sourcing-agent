import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CandidateCard } from "@/components/sourcing/candidate-card";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { keyDifferences } from "@/components/sourcing/evidence-sections";
import { Badge, ExternalLink, Icon, Notice, SectionTitle } from "@/components/sourcing/primitives";
import { RunRefresher } from "@/components/sourcing/run-refresher";
import { StageTimeline } from "@/components/sourcing/stage-timeline";
import type { SourcingEntry } from "@/lib/sourcing/orchestration/assemble";
import { candidateImageUrl, getRun, referenceImageUrl } from "@/lib/sourcing/ui/data";
import {
  caseTitle,
  classificationLabel,
  CLASSIFICATION_LABELS,
  CONFIDENCE_EXPLANATION,
  COSINE_EXPLANATION,
  EVIDENCE_STATUS_TEXT,
  formatDate,
  humanize,
  INDEX_EXPLANATION,
  RUN_STATUS_LABELS,
} from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";

type Params = { params: Promise<{ caseId: string; runId: string }>; searchParams: Promise<{ sort?: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: `${caseTitle((await params).caseId)} results` };
}

/** Larger runs render this many cards per section; the rest are listed compactly. */
const CARD_LIMIT = 48;

export default async function RunPage({ params, searchParams }: Params) {
  if (!(await localPageAllowed())) return null;
  const { caseId, runId } = await params;
  const sort = (await searchParams).sort === "retrieval" ? "retrieval" : "verification";
  const run = await getRun(localPaths(), caseId, runId);
  if (!run) notFound();
  const { result, summary } = run;
  const status = RUN_STATUS_LABELS[summary.status] ?? { label: summary.status, tone: "neutral" as const };
  const base = `/sourcing/references/${caseId}/runs/${runId}`;
  const imageOf = (e: SourcingEntry) => (e.imageEvidence.image ? candidateImageUrl(caseId, runId, e.listingId) : null);
  const top = result?.verified[0];
  const all = result ? [...result.verified, ...result.abstained, ...result.unverified] : [];
  const byRetrieval = [...all].sort((a, b) => (a.retrieval.siglipRank ?? Infinity) - (b.retrieval.siglipRank ?? Infinity) || (a.listingId < b.listingId ? -1 : 1));

  return (
    <div className="space-y-12">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
        <Link href="/sourcing/workspace" className="min-h-10 content-center hover:text-ink">
          Workspace
        </Link>
        <Icon name="forward" className="h-3.5 w-3.5" />
        <Link href={`/sourcing/references/${caseId}`} className="min-h-10 content-center hover:text-ink">
          {caseTitle(caseId)}
        </Link>
        <Icon name="forward" className="h-3.5 w-3.5" />
        <span className="font-mono text-xs text-ink-soft">{runId}</span>
      </nav>

      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {summary.synthetic ? <Badge tone="warn">Synthetic data — not real Alibaba.com listings</Badge> : null}
          <span className="text-sm text-muted">Recorded {formatDate(summary.createdAt)} · no external requests</span>
        </div>
        <h1 className="font-serif text-4xl text-ink">Sourcing results for {caseTitle(caseId)}</h1>
        {result ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Candidates", result.counts.candidates],
              ["With usable image", result.counts.withLocalImage],
              ["SigLIP-ranked", result.counts.shortlisted],
              ["Visually verified", result.counts.verified],
              ["Unverified", result.counts.unverified + result.counts.abstained],
              ["Acquisition", humanize(result.source.acquisitionMethod)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-line bg-paper p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="mt-1 font-serif text-2xl text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </header>

      {summary.status === "running" ? <RunRefresher caseId={caseId} runId={runId} /> : null}
      {summary.status === "interrupted" ? (
        <Notice tone="warn" title="This run was interrupted">
          Its journal stopped updating before it finished. Start a new run from saved evidence; nothing external is repeated.
        </Notice>
      ) : null}
      {run.resultProblem ? <Notice tone="bad" title="The saved result could not be read">{run.resultProblem}</Notice> : null}
      {!result && summary.status !== "running" ? (
        <Notice tone="warn" title="No consolidated result for this run">
          See the stages below for where it stopped and why.
        </Notice>
      ) : null}

      {top ? (
        <section aria-labelledby="top" className="rounded-3xl border border-line bg-paper p-4 sm:p-6 lg:p-8">
          <SectionTitle id="top" eyebrow="Closest verified design" title={top.title} />
          <div className="grid gap-4 md:grid-cols-2">
            <EvidenceImage src={referenceImageUrl(caseId)} alt={`Reference photo: ${caseTitle(caseId)}`} label="Reference" priority />
            <EvidenceImage src={imageOf(top)} alt={`Candidate photo: ${top.title}`} label="Candidate" priority />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-serif text-5xl tabular-nums text-ink" aria-label={`Design index ${top.verification.designSimilarityIndex} of 100`}>
                  {top.verification.designSimilarityIndex}
                  <span className="text-lg text-muted">/100</span>
                </span>
                <div className="space-y-1">
                  <Badge tone="ok" icon="check">{classificationLabel(top.verification.classification)}</Badge>
                  <p className="text-sm text-ink-soft">{top.verification.confidence} confidence in this assessment</p>
                </div>
              </div>
              <p className="text-sm text-muted">{INDEX_EXPLANATION}</p>
              <p className="text-sm text-muted">{CONFIDENCE_EXPLANATION}</p>
              {top.verification.classification ? <p className="text-sm text-muted">{CLASSIFICATION_LABELS[top.verification.classification]?.description}</p> : null}
            </div>
            <div className="space-y-4">
              {top.verification.summary ? <blockquote className="border-l-2 border-accent pl-4 font-serif text-lg leading-relaxed text-ink">{top.verification.summary}</blockquote> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Icon name="check" className="h-4 w-4 text-ok" /> Shared structure
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-sm text-ink-soft">
                    {top.verification.matches.slice(0, 4).map((m, i) => (
                      <li key={i}>{humanize(m.feature)}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Icon name="partial" className="h-4 w-4 text-warn" /> Most important differences
                  </h3>
                  <ul className="mt-1.5 space-y-1 text-sm text-ink-soft">
                    {keyDifferences(top.verification, 4).map((d, i) => (
                      <li key={i}>
                        <span className="sr-only">{d.kind === "partial" ? "Partial difference: " : "Mismatch: "}</span>
                        {d.kind === "partial" ? "◐ " : "✕ "}
                        {d.text}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {top.verification.limitations.length ? (
                <p className="text-sm text-muted">
                  <span className="font-medium text-ink-soft">Image limitations: </span>
                  {top.verification.limitations.join(" ")}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4 text-sm">
                <Link href={`${base}/candidates/${encodeURIComponent(top.listingId)}`} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-paper hover:bg-ink-soft">
                  Compare in detail <Icon name="forward" className="h-4 w-4" />
                </Link>
                <ExternalLink href={top.listingUrl}>Open Alibaba listing</ExternalLink>
                <span className="text-muted">Supplier: {top.supplier?.name ?? "Not provided"}</span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {result ? (
        <section aria-labelledby="candidates">
          <SectionTitle id="candidates" eyebrow={sort === "verification" ? "Verification order" : "Retrieval order"} title={sort === "verification" ? "Visually verified candidates" : "All candidates by SigLIP retrieval rank"}>
            <div role="group" aria-label="Order candidates by" className="inline-flex rounded-full border border-line bg-paper p-1 text-sm">
              {(["verification", "retrieval"] as const).map((s) => (
                <Link
                  key={s}
                  href={s === "verification" ? base : `${base}?sort=retrieval`}
                  aria-current={sort === s ? "true" : undefined}
                  className={`min-h-9 content-center rounded-full px-3 ${sort === s ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
                >
                  {s === "verification" ? "Sol verification" : "SigLIP retrieval"}
                </Link>
              ))}
            </div>
          </SectionTitle>
          <p className="mb-5 max-w-3xl text-sm text-muted">{sort === "verification" ? result.ordering : COSINE_EXPLANATION}</p>
          {sort === "verification" ? (
            result.verified.length ? (
              <ol className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {result.verified.slice(0, CARD_LIMIT).map((e) => (
                  <li key={e.listingId} className="relative">
                    <span className="absolute -left-2 -top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-accent font-serif text-sm text-paper shadow" aria-label={`Verification rank ${e.verification.verificationRank}`}>
                      {e.verification.verificationRank}
                    </span>
                    <CandidateCard entry={e} imageUrl={imageOf(e)} href={`${base}/candidates/${encodeURIComponent(e.listingId)}`} />
                  </li>
                ))}
              </ol>
            ) : (
              <Notice tone="neutral" title="No candidate has been visually verified in this run">
                Unverified candidates are listed below with the reason. They are not non-matches.
              </Notice>
            )
          ) : (
            <ol className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {byRetrieval.slice(0, CARD_LIMIT).map((e) => (
                <li key={e.listingId}>
                  <CandidateCard entry={e} imageUrl={imageOf(e)} href={`${base}/candidates/${encodeURIComponent(e.listingId)}`} />
                </li>
              ))}
            </ol>
          )}
          {(sort === "verification" ? result.verified.length : byRetrieval.length) > CARD_LIMIT ? (
            <p className="mt-4 text-sm text-muted">Showing the first {CARD_LIMIT}; the full list is in result.json.</p>
          ) : null}
        </section>
      ) : null}

      {result && sort === "verification" && result.abstained.length + result.unverified.length ? (
        <section aria-labelledby="unverified">
          <SectionTitle id="unverified" eyebrow="Listed, not scored" title="Not visually verified" />
          <p className="mb-5 max-w-3xl text-sm text-muted">These candidates have no design assessment in this run. They are not treated as non-matches; the reason is shown on each.</p>
          <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {[...result.abstained, ...result.unverified].slice(0, CARD_LIMIT).map((e) => (
              <li key={e.listingId} className="space-y-2">
                <CandidateCard entry={e} imageUrl={imageOf(e)} href={`${base}/candidates/${encodeURIComponent(e.listingId)}`} />
                {e.imageEvidence.status !== "available" ? <p className="text-xs text-muted">{EVIDENCE_STATUS_TEXT[e.imageEvidence.status] ?? e.imageEvidence.status}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="progress">
        <details open={!result || summary.status !== "completed"} className="group rounded-2xl border border-line bg-paper">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
            <span id="progress" className="font-serif text-xl text-ink">
              Run progress
            </span>
            <span className="text-sm text-muted">Recorded stage states from the run journal</span>
          </summary>
          <div className="border-t border-line px-5 py-5">
            <StageTimeline stages={run.stages} />
            {run.resumedAt.length ? <p className="mt-4 text-xs text-muted">Resumed {run.resumedAt.map(formatDate).join(", ")}</p> : null}
          </div>
        </details>
      </section>

      {result && (result.warnings.length || result.followUps.length) ? (
        <section aria-labelledby="notes" className="grid gap-4 lg:grid-cols-2">
          <h2 id="notes" className="sr-only">
            Warnings and follow-up
          </h2>
          {result.warnings.length ? (
            <Notice tone="warn" title="Warnings">
              <ul className="list-disc space-y-1 pl-5">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {result.followUps.length ? (
            <Notice tone="info" title="Possible next steps (each needs its own explicit approval)">
              <ul className="list-disc space-y-1 pl-5">
                {result.followUps.map((w, i) => (
                  <li key={i} className="break-words">{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section aria-labelledby="models" className="grid gap-3 text-sm sm:grid-cols-2">
          <h2 id="models" className="sr-only">
            Model provenance
          </h2>
          <div className="rounded-xl border border-line bg-paper p-4">
            <p className="text-xs text-muted">Retrieval</p>
            <p className="mt-1 text-ink">{result.models.siglip ? `${result.models.siglip.id} @ ${result.models.siglip.revision.slice(0, 12)}` : "No SigLIP shortlist"}</p>
          </div>
          <div className="rounded-xl border border-line bg-paper p-4">
            <p className="text-xs text-muted">Verification</p>
            <p className="mt-1 text-ink">
              {result.models.sol.model}, instructions {result.models.sol.instructionsVersion} · {result.recordedUsage.solResponses} saved assessments reused
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
