import type { EvidenceItem, SourcingEntry } from "@/lib/sourcing/orchestration/assemble";
import { humanize } from "@/lib/sourcing/ui/labels";
import { Icon, type IconName } from "./primitives";

/**
 * Sol's structured evidence for one candidate, grouped so that partial
 * structural differences (e.g. a different number of repeated arches) stay as
 * visible as matches and mismatches. Text is shown as recorded.
 */

const GROUPS: { key: keyof Pick<SourcingEntry["verification"], "matches" | "partialStructuralDifferences" | "structuralMismatches" | "appearanceDifferences">; title: string; description: string; icon: IconName; tone: string }[] = [
  { key: "matches", title: "Matching features", description: "Design characteristics visible in both photographs.", icon: "check", tone: "text-ok" },
  { key: "partialStructuralDifferences", title: "Partial structural differences", description: "Shared design motif that differs in count, proportion or arrangement.", icon: "partial", tone: "text-warn" },
  { key: "structuralMismatches", title: "Structural mismatches", description: "Geometry that differs substantially.", icon: "x", tone: "text-bad" },
  { key: "appearanceDifferences", title: "Appearance differences", description: "Colour, finish or material appearance.", icon: "dot", tone: "text-info" },
];

function Item({ item }: { item: EvidenceItem }) {
  return (
    <li className="rounded-lg border border-line bg-paper p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-medium text-ink">{humanize(item.feature)}</p>
        <p className="text-xs text-muted">
          {item.importance} · {item.basis === "observed" ? "observed in both photos" : item.basis}
        </p>
      </div>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Reference</dt>
          <dd className="text-ink-soft">{item.reference ?? "Not visible"}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Candidate</dt>
          <dd className="text-ink-soft">{item.candidate ?? "Not visible"}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-ink-soft">{item.explanation}</p>
      {item.limitation ? <p className="mt-1 text-xs text-muted">Limitation: {item.limitation}</p> : null}
    </li>
  );
}

export function EvidenceSections({ v }: { v: SourcingEntry["verification"] }) {
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const items = v[g.key];
        return (
          <section key={g.key} aria-labelledby={`ev-${g.key}`}>
            <h3 id={`ev-${g.key}`} className="flex items-center gap-2 font-medium text-ink">
              <Icon name={g.icon} className={`h-4 w-4 ${g.tone}`} />
              {g.title} <span className="text-sm font-normal text-muted">({items.length})</span>
            </h3>
            <p className="mb-2 text-sm text-muted">{g.description}</p>
            {items.length ? (
              <ul className="space-y-2">
                {items.map((item, i) => (
                  <Item key={`${item.feature}-${i}`} item={item} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None recorded.</p>
            )}
          </section>
        );
      })}
      <section aria-labelledby="ev-limits">
        <h3 id="ev-limits" className="flex items-center gap-2 font-medium text-ink">
          <Icon name="info" className="h-4 w-4 text-muted" />
          Visibility limitations
        </h3>
        {v.limitations.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {v.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">None recorded.</p>
        )}
      </section>
      <section aria-labelledby="ev-uncertain">
        <h3 id="ev-uncertain" className="flex items-center gap-2 font-medium text-ink">
          <Icon name="alert" className="h-4 w-4 text-muted" />
          Uncertain claims
        </h3>
        {v.uncertainClaims.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {v.uncertainClaims.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">None recorded.</p>
        )}
      </section>
    </div>
  );
}

/** The most important differences, for compact cards: partial structural first (they are often the decisive detail). */
export function keyDifferences(v: SourcingEntry["verification"], max = 3): { text: string; kind: "partial" | "mismatch" }[] {
  const rank = (i: EvidenceItem) => (i.importance === "defining" ? 0 : i.importance === "supporting" ? 1 : 2);
  return [
    ...v.partialStructuralDifferences.map((i) => ({ i, kind: "partial" as const })),
    ...v.structuralMismatches.map((i) => ({ i, kind: "mismatch" as const })),
  ]
    .sort((a, b) => rank(a.i) - rank(b.i))
    .slice(0, max)
    .map(({ i, kind }) => ({ text: `${humanize(i.feature)}: ${i.candidate ?? "not visible"}`, kind }));
}
