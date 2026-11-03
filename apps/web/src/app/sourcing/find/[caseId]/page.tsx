import type { Metadata } from "next";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { FindView } from "@/components/sourcing/intake/find-view";
import { Notice } from "@/components/sourcing/primitives";
import type { AutomaticSearchCard } from "@/components/sourcing/intake/automatic-search-view";
import { automaticSearchPlan, listAutomaticSearches } from "@/lib/sourcing/ui/discovery/automatic-search";
import { getReference, getRun } from "@/lib/sourcing/ui/data";
import { loadRunJournal } from "@/lib/sourcing/orchestration/journal";
import { getIntakeState } from "@/lib/sourcing/ui/intake/intake";
import { describeRevision, readCollection } from "@/lib/sourcing/ui/intake/revision";
import { humanize } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { loadSavedFingerprint } from "@/lib/sourcing/understanding/saved/saved-fingerprint";

export const metadata: Metadata = { title: "Find similar products" };

/** Find similar products for an analysed photo. Reads saved records only; loading it never searches or contacts a provider. */
export default async function FindPage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { caseId } = await params;
  const paths = localPaths();
  const ref = await getReference(paths, caseId);
  if (!ref) notFound();
  if (ref.understanding !== "furniture_identified" || ref.synthetic) {
    return (
      <Notice tone="neutral" title="This photo isn't ready for product search">
        Products can be found only for a photo whose furniture has been analyzed.
      </Notice>
    );
  }
  const saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  const fp = saved.fingerprint;
  // Eligibility is computed from configuration and the private access record; no request is made.
  const plan = await automaticSearchPlan(paths, saved);
  const [intake, collection, searches] = await Promise.all([getIntakeState(paths, caseId), readCollection(paths, caseId), listAutomaticSearches(paths, caseId)]);
  // Each run records the hash of the product set it used, so a run belongs to the hand-collected list or to one automatic search.
  const runs: { runId: string; sha: string | null }[] = [];
  for (const r of ref.runs.filter((x) => x.result.available)) {
    const journal = await loadRunJournal(join(paths.sourcingRuns, caseId, r.runId)).catch(() => null);
    runs.push({ runId: r.runId, sha: journal?.resolved.manifestSha256 ?? null });
  }
  const runFor = async (sha: string | null) => {
    const hit = sha ? runs.find((r) => r.sha === sha) : undefined;
    const result = hit ? (await getRun(paths, caseId, hit.runId))?.result : null;
    return hit && result ? { runId: hit.runId, shortlisted: result.counts.shortlisted, compared: result.counts.verified } : null;
  };
  // The hand-collected list's latest run (automatic-search runs are shown with their search).
  const autoShas = new Set(searches.map((s) => s.manifestSha256).filter(Boolean));
  const latest = runs.find((r) => !r.sha || !autoShas.has(r.sha));
  const result = latest ? (await getRun(paths, caseId, latest.runId))?.result : null;
  const current = Boolean(collection && latest?.sha === collection.sha256);
  const cards: AutomaticSearchCard[] = [];
  for (const s of searches) {
    cards.push({
      discoveryId: s.discoveryId,
      createdAt: s.createdAt,
      status: s.status,
      unfinished: s.unfinished,
      meaning: s.meaning,
      summary: s.summary,
      products: s.products.map((p, i) => ({ title: p.title, listingUrl: p.listingUrl, imageUrl: p.localImage ? `/api/sourcing/evidence/discovery/${caseId}/${s.discoveryId}/${i}` : null, price: p.price ?? null, minimumOrder: p.minimumOrder ?? null })),
      run: await runFor(s.manifestSha256),
    });
  }
  return (
    <FindView
      caseId={caseId}
      photoUrl={ref.photo.url}
      furnitureType={`${humanize(fp.category)}${fp.subtype ? ` · ${humanize(fp.subtype)}` : ""}`}
      queries={fp.searchQueries}
      automatic={{
        available: plan.eligibility.eligible && plan.problems.length === 0,
        reason: plan.eligibility.eligible ? plan.problems.join("; ") : "No approved marketplace data source is set up, so products are added by hand for now.",
        providerLabel: plan.providerLabel,
        searches: cards,
      }}
      intake={intake}
      collection={collection ? { products: collection.products, withPhoto: collection.withPhoto, revisable: collection.revisable } : null}
      revisionChanges={intake.draft ? await describeRevision(paths, intake.draft) : null}
      latestRun={result && latest ? { runId: latest.runId, current, shortlisted: result.counts.shortlisted, compared: result.counts.verified } : null}
    />
  );
}
