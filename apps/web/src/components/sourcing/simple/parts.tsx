import Link from "next/link";
import type { ReactNode } from "react";
import type { SourcingEntry } from "@/lib/sourcing/orchestration/assemble";
import { DIFFERENCE_KIND_LABELS, listedTerms, plainVerdict, shortTitle, keyDifference, type Difference } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Badge, ExternalLink, Icon } from "../primitives";

/** Building blocks for the simple experience: plain words, photographs first. */

/** One recorded difference, quoting the original and candidate observations side by side. */
export function DifferenceNote({ d, compact = false }: { d: Difference; compact?: boolean }) {
  return (
    <div className={compact ? "text-sm" : ""}>
      <p className={`font-medium text-ink ${compact ? "" : "text-base"}`}>
        {d.feature}
        <span className="ml-2 text-xs font-normal text-muted">{DIFFERENCE_KIND_LABELS[d.kind]}</span>
      </p>
      <dl className={`mt-1 grid gap-x-4 gap-y-0.5 ${compact ? "text-sm" : "sm:grid-cols-2"}`}>
        <div className="flex gap-1.5">
          <dt className="shrink-0 font-medium text-muted">Original:</dt>
          <dd className="text-ink-soft">{d.original ?? "Not visible"}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="shrink-0 font-medium text-muted">This design:</dt>
          <dd className="text-ink-soft">{d.candidate ?? "Not visible"}</dd>
        </div>
      </dl>
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft">
      {children}
    </Link>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-line-strong bg-paper px-6 text-base font-medium text-ink hover:border-ink">
      {children}
    </Link>
  );
}

/** A native disclosure, styled consistently; content is only for readers who ask for it. */
export function Disclosure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border border-line bg-paper">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="font-serif text-lg text-ink">{title}</span>
          {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
        </span>
        <Icon name="forward" className="h-5 w-5 shrink-0 text-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-line px-5 py-5">{children}</div>
    </details>
  );
}

/** A compact product card: photo, short name, plain verdict, one difference, supplier. */
export function ProductCard({ entry, imageUrl, href }: { entry: SourcingEntry; imageUrl: string | null; href: string }) {
  const verdict = plainVerdict(entry);
  const diff = verdict.compared ? keyDifference(entry.verification) : null;
  const name = shortTitle(entry.title);
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-paper">
      <EvidenceImage src={imageUrl} alt={`Product photo: ${name}`} zoomable={false} aspect="aspect-[4/3]" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <Badge tone={verdict.tone} icon={verdict.compared ? "check" : "minus"}>
            {verdict.label}
          </Badge>
          <h3 className="mt-2 font-serif text-lg leading-snug text-ink" title={entry.title}>
            {name}
          </h3>
        </div>
        {diff ? (
          <p className="text-sm text-ink-soft">
            <span className="font-medium text-ink">Main difference: </span>
            {diff.feature.toLowerCase()} — {diff.candidate ?? "not visible"}
          </p>
        ) : !verdict.compared ? (
          <p className="text-sm text-ink-soft">{verdict.sentence}</p>
        ) : null}
        <div className="mt-auto space-y-1 text-sm">
          <p className="text-ink">{entry.supplier?.name ?? "Supplier not listed"}</p>
          <p className="text-xs text-muted">{listedTerms(entry)}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Link href={href} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong px-4 text-sm font-medium text-ink hover:border-ink">
            Compare<span className="sr-only"> with the original: {name}</span>
            <Icon name="forward" className="h-4 w-4" />
          </Link>
          <ExternalLink href={entry.listingUrl} className="text-sm">
            Alibaba listing
          </ExternalLink>
        </div>
      </div>
    </article>
  );
}

/** The honest status line shown wherever saved example data appears. */
export function SavedExampleNote({ synthetic = false }: { synthetic?: boolean }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted">
      <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {synthetic
          ? "This example uses made-up test listings, not real Alibaba products."
          : "This example uses saved Alibaba listings. Live marketplace search is not yet available."}
      </span>
    </p>
  );
}
