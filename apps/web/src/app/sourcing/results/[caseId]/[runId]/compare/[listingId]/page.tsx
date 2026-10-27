import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SimpleCompareView } from "@/components/sourcing/simple/compare";
import { getRun, LISTING_ID } from "@/lib/sourcing/ui/data";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";

export const metadata: Metadata = { title: "Compare designs" };

export default async function SimpleComparePage({ params }: { params: Promise<{ caseId: string; runId: string; listingId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { caseId, runId, listingId: raw } = await params;
  const listingId = decodeURIComponent(raw);
  if (!LISTING_ID.test(listingId)) notFound();
  const result = (await getRun(localPaths(), caseId, runId))?.result;
  const entry = result && [...result.verified, ...result.abstained, ...result.unverified].find((e) => e.listingId === listingId);
  if (!result || !entry) notFound();
  return <SimpleCompareView caseId={caseId} runId={runId} result={result} entry={entry} />;
}
