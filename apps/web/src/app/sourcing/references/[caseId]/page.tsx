import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { Badge, Eyebrow, Icon, Notice, SectionTitle } from "@/components/sourcing/primitives";
import { RunOfflineButton } from "@/components/sourcing/run-offline-button";
import type { FurnitureFeature } from "@/lib/sourcing/domain";
import { getReference } from "@/lib/sourcing/ui/data";
import { formatDate, caseTitle, humanize, READINESS_LABELS, RUN_STATUS_LABELS } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";

type Params = { params: Promise<{ caseId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: caseTitle((await params).caseId) };
}

const CERTAINTY: Record<FurnitureFeature["certainty"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  observed: { label: "Observed", tone: "ok" },
  inferred: { label: "Inferred", tone: "warn" },
  unknown: { label: "Not determinable", tone: "neutral" },
};

function FeatureList({ title, features }: { title: string; features: FurnitureFeature[] }) {
  if (features.length === 0) return null;
  return (
    <section>
      <h3 className="font-medium text-ink">{title}</h3>
      <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-paper">
        {features.map((f, i) => (
          <li key={`${f.attribute}-${i}`} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{humanize(f.attribute)}</p>
              <p className="text-sm text-ink-soft">{f.certainty === "unknown" ? (f.rationale ?? "Could not be determined from the photo.") : f.value}</p>
              {f.certainty !== "unknown" && f.rationale ? <p className="mt-0.5 text-xs text-muted">{f.rationale}</p> : null}
            </div>
            <span className="shrink-0">
              <Badge tone={CERTAINTY[f.certainty].tone}>{CERTAINTY[f.certainty].label}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function ReferencePage({ params }: Params) {
  if (!(await localPageAllowed())) return null;
  const { caseId } = await params;
  const ref = await getReference(localPaths(), caseId);
  if (!ref) notFound();
  const readiness = READINESS_LABELS[ref.readiness];
  const latest = ref.runs.find((r) => r.result.available);
  const canRun = !ref.synthetic && ref.understanding === "furniture_identified" && ref.candidates.state === "completed";

  return (
    <div className="space-y-12">
      <nav aria-label="Breadcrumb">
        <Link href="/sourcing/workspace" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" className="h-4 w-4" /> Workspace
        </Link>
      </nav>

      <section className="grid gap-8 lg:grid-cols-[1.15fr_1fr]">
        <EvidenceImage src={ref.photo.url} alt={`Reference photo: ${caseTitle(caseId)}`} label="Reference" priority aspect="aspect-[4/5] sm:aspect-[5/4] lg:aspect-[4/5]" />
        <div className="space-y-6">
          <div>
            <Eyebrow>Furniture reference</Eyebrow>
            <h1 className="mt-2 font-serif text-4xl text-ink">{caseTitle(caseId)}</h1>
            <p className="mt-2 text-lg text-ink-soft">
              {ref.category ? humanize(ref.category) : "Category not recorded"}
              {ref.subtype ? ` · ${humanize(ref.subtype)}` : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge tone={readiness.tone}>{readiness.label}</Badge>
              {ref.synthetic ? <Badge tone="warn">Synthetic demonstration data</Badge> : null}
            </div>
            <p className="mt-2 text-sm text-muted">{readiness.description}</p>
          </div>
          {!ref.photo.available ? (
            <Notice tone="warn" title="Reference photo unavailable">
              {ref.synthetic ? "Synthetic cases record an image hash only." : "The mapped photo is missing or differs from the analysed image, so it cannot be shown."}
            </Notice>
          ) : null}
          {ref.understanding !== "furniture_identified" ? (
            <Notice tone="warn" title="No furniture fingerprint">
              {ref.understandingNote ?? "There is no saved image-understanding result for this reference."}
            </Notice>
          ) : null}
          <div className="rounded-2xl border border-line bg-paper p-5">
            <h2 className="font-medium text-ink">Next step</h2>
            {latest ? (
              <Link
                href={`/sourcing/references/${caseId}/runs/${latest.runId}`}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper hover:bg-ink-soft"
              >
                View sourcing results <Icon name="forward" className="h-4 w-4" />
              </Link>
            ) : null}
            {canRun ? (
              <div className={latest ? "mt-5 border-t border-line pt-5" : "mt-3"}>
                <RunOfflineButton caseId={caseId} />
              </div>
            ) : !latest ? (
              <p className="mt-2 text-sm text-ink-soft">
                {ref.candidates.state !== "completed"
                  ? "No marketplace candidates have been collected for this reference. Automated discovery awaits authorized provider access; operator-recorded candidates can be added with pnpm source:candidates."
                  : "This reference cannot be run from saved evidence."}
              </p>
            ) : null}
          </div>
          {ref.fingerprint ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-line bg-paper p-3">
                <dt className="text-xs text-muted">Fingerprint source</dt>
                <dd className="mt-1 text-ink">{ref.fingerprint.source}</dd>
              </div>
              <div className="rounded-xl border border-line bg-paper p-3">
                <dt className="text-xs text-muted">Recorded</dt>
                <dd className="mt-1 text-ink">{formatDate(ref.fingerprint.createdAt)}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </section>

      {ref.fingerprint ? (
        <section aria-labelledby="fp">
          <SectionTitle id="fp" eyebrow="Saved image understanding" title="What the model observed">
            <p className="max-w-md text-sm text-muted">From the saved GPT-6 Luna fingerprint; nothing was re-analysed to show this. Inferred and undeterminable features are marked.</p>
          </SectionTitle>
          <div className="grid gap-6 lg:grid-cols-3">
            <FeatureList title="Distinctive features" features={ref.fingerprint.distinctive} />
            <FeatureList title="Structure" features={ref.fingerprint.structure} />
            <FeatureList title="Appearance" features={ref.fingerprint.appearance} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="runs">
        <SectionTitle id="runs" eyebrow="History" title="Sourcing runs" />
        {ref.runs.length === 0 ? (
          <p className="text-sm text-muted">No sourcing runs yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-paper">
            {ref.runs.map((run) => {
              const st = RUN_STATUS_LABELS[run.status] ?? { label: run.status, tone: "neutral" as const };
              return (
                <li key={run.runId}>
                  <Link href={`/sourcing/references/${caseId}/runs/${run.runId}`} className="flex flex-col gap-2 px-4 py-3 hover:bg-sand/60 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm text-ink">{run.runId}</p>
                      <p className="text-xs text-muted">
                        {formatDate(run.createdAt)} · {run.sourceKind ? humanize(run.sourceKind) : "unknown source"}
                        {run.result.counts ? ` · ${run.result.counts.verified} of ${run.result.counts.candidates} verified` : ""}
                        {run.problem ?? run.result.problem ? ` · ${run.problem ?? run.result.problem}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {run.synthetic ? <Badge tone="warn">Synthetic</Badge> : null}
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
