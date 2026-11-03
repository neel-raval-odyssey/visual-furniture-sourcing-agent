import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { ConfirmSearchButton } from "@/components/sourcing/intake/automatic-search-controls";
import { Icon, Notice } from "@/components/sourcing/primitives";
import { getReference } from "@/lib/sourcing/ui/data";
import { automaticSearchPlan } from "@/lib/sourcing/ui/discovery/automatic-search";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { loadSavedFingerprint } from "@/lib/sourcing/understanding/saved/saved-fingerprint";

export const metadata: Metadata = { title: "Search automatically" };
export const dynamic = "force-dynamic";

/**
 * Confirmation before an automatic search (nothing is sent by viewing it). It
 * states the source, what leaves this computer, possible charges, limits,
 * photo handling and the status of supplier data, and offers the search only
 * when the source is eligible. A fresh request key is created per visit.
 */
export default async function SearchConfirmPage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { caseId } = await params;
  const paths = localPaths();
  const ref = await getReference(paths, caseId);
  if (!ref || ref.understanding !== "furniture_identified" || ref.synthetic) notFound();
  const saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  const plan = await automaticSearchPlan(paths, saved);
  const ready = plan.eligibility.eligible && plan.problems.length === 0;
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Link href={`/sourcing/find/${caseId}`} className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Back
      </Link>
      <header className="space-y-2">
        <h1 className="font-serif text-4xl text-ink">Search automatically</h1>
        <p className="text-lg text-ink-soft">Check what will happen, then confirm.</p>
      </header>
      {!ready ? (
        <Notice tone="neutral" title="Automatic search isn't available">
          {plan.eligibility.eligible ? plan.problems.join("; ") : "No approved marketplace data source is set up, so products are added by hand for now."}
        </Notice>
      ) : null}
      <dl className="space-y-4 rounded-2xl border border-line bg-paper p-5 text-sm">
        <div>
          <dt className="font-medium text-ink">Source</dt>
          <dd className="text-ink-soft">A web search index (Exa) limited to Alibaba.com product pages. It is not Alibaba.com and does not check the listings or suppliers.</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">What is sent</dt>
          <dd className="text-ink-soft">Only the text descriptions saved from your photo&apos;s analysis. Your photo is not sent.</dd>
          <dd className="mt-1">
            <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">
              {plan.queries.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Charges</dt>
          <dd className="text-ink-soft">
            The search service charges per request: about ${plan.estimatedUsd.toFixed(2)} for this search, never more than ${plan.costCapUsd.toFixed(2)}. Requests are not repeated automatically.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Limits</dt>
          <dd className="text-ink-soft">
            {plan.maxRequests} searches of up to {plan.resultsPerQuery} results each; at most {plan.maxUniqueLeads} different products are kept.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Product photos</dt>
          <dd className="text-ink-soft">
            {plan.imageRetrieval.allowed
              ? "One photo per product is downloaded from Alibaba.com's image servers and kept on this computer for comparison."
              : "Product photos will not be downloaded (not approved). Products without a photo can't be compared with yours."}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Suppliers and prices</dt>
          <dd className="text-ink-soft">Shown only as the source reports them. This source does not report suppliers; prices come from indexed page text and may be out of date.</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Your existing products</dt>
          <dd className="text-ink-soft">Results are saved as a separate set. Products you recorded by hand are not changed.</dd>
        </div>
      </dl>
      {ready ? (
        <ConfirmSearchButton caseId={caseId} requestKey={randomUUID()} />
      ) : (
        <button type="button" disabled aria-disabled className="inline-flex min-h-12 cursor-not-allowed items-center rounded-full border border-line px-6 text-base text-muted">
          Confirm and search (unavailable)
        </button>
      )}
    </div>
  );
}
