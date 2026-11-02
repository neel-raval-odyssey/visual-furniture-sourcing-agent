import type { Metadata } from "next";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { FindView } from "@/components/sourcing/intake/find-view";
import { Notice } from "@/components/sourcing/primitives";
import { discoveryReadiness, loadAccessRecord } from "@/lib/sourcing/discovery/authorization";
import { getReference, getRun } from "@/lib/sourcing/ui/data";
import { loadRunJournal } from "@/lib/sourcing/orchestration/journal";
import { getIntakeState } from "@/lib/sourcing/ui/intake/intake";
import { describeRevision, readCollection } from "@/lib/sourcing/ui/intake/revision";
import { humanize } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { loadSavedFingerprint } from "@/lib/sourcing/understanding/saved/saved-fingerprint";

export const metadata: Metadata = { title: "Find similar products" };

/** Find similar products for an analysed photo. Reads saved records only; never searches or contacts a provider. */
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
  const readiness = discoveryReadiness("image", process.env, await loadAccessRecord(join(paths.root, "evals/local/marketplace-access.json")));
  const eligible = readiness.find((r) => r.eligible);
  const latest = ref.runs.find((r) => r.result.available);
  const run = latest ? await getRun(paths, caseId, latest.runId) : null;
  const result = run?.result;
  const [intake, collection] = await Promise.all([getIntakeState(paths, caseId), readCollection(paths, caseId)]);
  // A run is current when it was made from exactly the saved list shown now (its journal records the manifest hash).
  const journal = latest ? await loadRunJournal(join(paths.sourcingRuns, caseId, latest.runId)).catch(() => null) : null;
  const current = Boolean(collection && journal?.resolved.manifestSha256 === collection.sha256);
  return (
    <FindView
      caseId={caseId}
      photoUrl={ref.photo.url}
      furnitureType={`${humanize(fp.category)}${fp.subtype ? ` · ${humanize(fp.subtype)}` : ""}`}
      queries={fp.searchQueries}
      automatic={{ available: Boolean(eligible), reason: eligible ? "" : "No approved marketplace data source is set up, so products are added by hand for now." }}
      intake={intake}
      collection={collection ? { products: collection.products, withPhoto: collection.withPhoto, revisable: collection.revisable } : null}
      revisionChanges={intake.draft ? await describeRevision(paths, intake.draft) : null}
      latestRun={result ? { runId: latest!.runId, current, shortlisted: result.counts.shortlisted, compared: result.counts.verified } : null}
    />
  );
}
